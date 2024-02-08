const config = require("./config");
const path = require("path");
const http = require("http");
const https = require("https");
const { promises: fs } = require("fs");
const fsExtra = require("fs-extra");
const puppeteer = require("puppeteer");
const { CronJob } = require("cron");
const crypto = require("crypto");

(async () => {
  if (config.pages.length === 0) {
    return console.error("Please check your configuration");
  }
  for (const i in config.pages) {
    const pageConfig = config.pages[i];
    if (pageConfig.rotation % 90 > 0) {
      return console.error(
        `Invalid rotation value for entry ${i + 1}: ${pageConfig.rotation}`
      );
    }
  }

  console.log("Starting browser...");
  let browser = await puppeteer.launch({
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      `--lang=${config.language}`,
      config.ignoreCertificateErrors && "--ignore-certificate-errors"
    ].filter((x) => x),
    headless: config.debug !== true
  });

  console.log(`Visiting '${config.baseUrl}' to login...`);
  let page = await browser.newPage();
  await page.goto(config.baseUrl, {
    timeout: config.renderingTimeout,
    waitUntil: 'networkidle0',
  });

  console.log("Adding authentication entry to browser's local storage...");
  const hassTokens = {
    hassUrl: config.baseUrl,
    access_token: config.accessToken,
    token_type: "Bearer"
  };
  await page.evaluate(
    (hassTokens, selectedLanguage) => {
      localStorage.setItem("hassTokens", hassTokens);
      localStorage.setItem("selectedLanguage", selectedLanguage);
    },
    JSON.stringify(hassTokens),
    JSON.stringify(config.language)
  );

  page.close();

  if (config.debug) {
    console.log(
      "Debug mode active, will only render once in non-headless model and keep page open"
    );
    renderAndConvertAsync(browser);
  } else {
    console.log("Starting first render...");
    await renderAndConvertAsync(browser);
    console.log("Starting rendering cronjob...");
    for (let cronTime of config.cronJob.split(';')) {
      new CronJob({
        cronTime: cronTime,
        timeZone: config.timezone,
        onTick: () => renderAndConvertAsync(browser),
        start: true
      });
    }
  }

  const httpServer = http.createServer(async (request, response) => {
    // Parse the request
    const url = new URL(request.url, `http://${request.headers.host}`);
    // Check the page number
    const pageNumberStr = url.pathname;
    const pageNumber = pageNumberStr === "/" ? 1 : parseInt(pageNumberStr.substring(1));
    if (!isFinite(pageNumber) ||
        pageNumber > config.pages.length ||
        pageNumber < 1
    ) {
      console.log(`Invalid request: ${request.url} for page ${pageNumber}`);
      response.writeHead(400);
      response.end("Invalid request");
      return;
    }
    const pageIndex = pageNumber - 1;
    const pageConfig = config.pages[pageIndex];
    
    try {
      // Log when the page was accessed
      const n = new Date();
      console.log(`Image ${pageNumber} was accessed with ${url.search}`);

      let forceRefresh = url.searchParams.get('forceRefresh');
      if (forceRefresh > 3) {
        await renderAndConvertAsync(browser);
      }

      const stat = await fs.stat(pageConfig.outputPath);
      const data = await fs.readFile(pageConfig.outputPath);
      const hash = crypto.createHash("md5").update(data).digest('hex');

      const ifNoneMatch = request.headers["if-none-match"];
      const ifModifiedSince = new Date(request.headers["if-modified-since"]);

      if (forceRefresh == null && (ifNoneMatch == hash || ifModifiedSince > stat.mtime)) {
        response.writeHead(304, "Not Modified");
        response.end();
        console.log("Response: 304 Not Modified");
      } else {
        const lastModifiedTime = new Date(stat.mtime);
        const lastModifiedTimeLocal = lastModifiedTime.toLocaleString("en-US", {
            weekday: "short",
            year: "numeric",
            month: "numeric",
            day: "numeric",          
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
            timeZoneName: "short",
            timeZone: pageConfig.timezone,
        });

        response.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": Buffer.byteLength(data),
          "Last-Modified": lastModifiedTime.toUTCString(),
          "X-Last-Modified-Local": lastModifiedTimeLocal,
          "ETag": hash,
        });
        response.end(data);
        console.log("Response: 200 OK");
      }
    } catch (e) {
      console.error(e);
      response.writeHead(404);
      response.end("Image not found");
    }

    // Send battery status to HA
    try {
      if (pageConfig.batteryWebHook) {
        const batteryStatus = {
          batteryLevel: parseInt(url.searchParams.get("batteryLevel")),
          batteryVolts: parseFloat(url.searchParams.get("batteryVolts")),
          isCharging:   url.searchParams.get("isCharging"),
        };

        sendBatteryStatusToHomeAssistant(
          pageIndex,
          batteryStatus,
          pageConfig.batteryWebHook
        );
      }
    } catch (e) {
      console.error(e);
    }
  });

  const port = config.port || 5000;
  httpServer.listen(port, () => {
    console.log(`Server is running at ${port}`);
  });
})();

async function renderAndConvertAsync(browser) {
  for (let pageIndex = 0; pageIndex < config.pages.length; pageIndex++) {
    const pageConfig = config.pages[pageIndex];

    const url = `${config.baseUrl}${pageConfig.screenShotUrl}`;

    const outputPath = pageConfig.outputPath;
    await fsExtra.ensureDir(path.dirname(outputPath));

    console.log(`Rendering ${url} to image...`);
    await renderUrlToImageAsync(browser, pageConfig, url, outputPath);

    console.log(`Finished ${url}`);
  }
}

function sendBatteryStatusToHomeAssistant(
  pageIndex,
  batteryStatus,
  batteryWebHook
) {
  const batteryStatusStr = JSON.stringify(batteryStatus);
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(batteryStatusStr)
    },
    rejectUnauthorized: !config.ignoreCertificateErrors
  };
  const url = `${config.baseUrl}/api/webhook/${batteryWebHook}`;
  const httpLib = url.toLowerCase().startsWith("https") ? https : http;
  const req = httpLib.request(url, options, (res) => {
    if (res.statusCode !== 200) {
      console.error(
        `Update device ${pageIndex} at ${url} status ${res.statusCode}: ${res.statusMessage}`
      );
    }
  });
  req.on("error", (e) => {
    console.error(`Update ${pageIndex} at ${url} error: ${e.message}`);
  });
  req.write(batteryStatusStr);
  req.end();
}

async function renderUrlToImageAsync(browser, pageConfig, url, path) {
  let page;
  try {
    page = await browser.newPage();
    await page.emulateMediaFeatures([
      {
        name: "prefers-color-scheme",
        value: "light"
      }
    ]);
    await page.emulateTimezone(config.timezone);

    let size = {
      width: Number(pageConfig.renderingScreenSize.width),
      height: Number(pageConfig.renderingScreenSize.height)
    };

    if (pageConfig.rotation % 180 > 0) {
      size = {
        width: size.height,
        height: size.width
      };
    }

    await page.setViewport(size);
    const startTime = new Date().valueOf();
    await page.goto(url, {
      waitUntil: ["domcontentloaded", "load", "networkidle0"],
      timeout: config.renderingTimeout
    });

    const navigateTimespan = new Date().valueOf() - startTime;
    await page.waitForSelector("home-assistant", {
      timeout: Math.max(config.renderingTimeout - navigateTimespan, 1000)
    });

    await page.addStyleTag({
      content: `
        body {
          width: calc(${size.width}px / ${pageConfig.scaling});
          height: calc(${size.height}px / ${pageConfig.scaling});
          transform-origin: 0 0;
          transform: scale(${pageConfig.scaling});
          overflow: hidden;
        }`
    });

    if (pageConfig.renderingDelay > 0) {
      await new Promise(r => setTimeout(r, pageConfig.renderingDelay));
    }

    await page.screenshot({
      path,
      type: "png",
      clip: {
        x: 0,
        y: 0,
        ...size
      },
      captureBeyondViewport: false
    });
  } catch (e) {
    console.error("Failed to render", e);
  } finally {
    if (config.debug === false) {
      await page.close();
    }
  }
}

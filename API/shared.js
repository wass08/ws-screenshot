const puppeteer = require("puppeteer");

function envInt(name, fallback) {
  var value = parseInt(process.env[name]);
  return isNaN(value) || value <= 0 ? fallback : value;
}

//close the browser after this much idle time
const BROWSER_IDLE_CLOSE_MS = envInt("BROWSER_IDLE_CLOSE_MS", 30000);
//recycle the browser after this many screenshots, chromium memory grows over time
const MAX_JOBS_PER_BROWSER = envInt("MAX_JOBS_PER_BROWSER", 100);
//hard limit for one screenshot, guarantees the concurrency slot is released
const JOB_TIMEOUT_MS = envInt("JOB_TIMEOUT_MS", 120000);
const CLOSE_TIMEOUT_MS = 5000;

//one browser per worker thread, shared by all requests of that thread
//entry = { browser: Promise<Browser>, jobs, active, retired, idleTimer }
var current = null;

function withTimeout(promise, ms, message) {
  var timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function launchBrowser() {
  var entry = { jobs: 0, active: 0, retired: false, idleTimer: null };
  //store the promise right away so concurrent requests share a single launch
  entry.browser = puppeteer.launch({
    timeout: 30000,
    headless: "new",
    args: [
      "--no-sandbox",
      //docker's default /dev/shm is 64MB, too small for big pages
      "--disable-dev-shm-usage",
    ],
  });
  entry.browser.then(
    (browser) => {
      //chromium crashed or was killed: never reuse it
      browser.on("disconnected", () => retireBrowser(entry));
    },
    () => retireBrowser(entry)
  );
  return entry;
}

function acquireBrowser() {
  if (current != null && current.jobs >= MAX_JOBS_PER_BROWSER) {
    retireBrowser(current);
  }
  if (current == null) {
    current = launchBrowser();
  }
  current.jobs++;
  current.active++;
  clearTimeout(current.idleTimer);
  return current;
}

function releaseBrowser(entry) {
  entry.active--;
  if (entry.active > 0) {
    return;
  }
  if (entry.retired) {
    destroyBrowser(entry);
  } else {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => retireBrowser(entry), BROWSER_IDLE_CLOSE_MS);
  }
}

//stop handing out this browser, close it once its running jobs are done
function retireBrowser(entry) {
  entry.retired = true;
  clearTimeout(entry.idleTimer);
  if (current === entry) {
    current = null;
  }
  if (entry.active <= 0) {
    destroyBrowser(entry);
  }
}

async function destroyBrowser(entry) {
  if (entry.destroyed) {
    return;
  }
  entry.destroyed = true;

  var browser = null;
  try {
    browser = await entry.browser;
  } catch (ex) {
    return;
  }
  var proc = browser.process();
  try {
    await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, "browser.close() timed out");
  } catch (ex) {}
  //a hung chromium ignores close(), make sure no process is left behind
  if (proc != null && proc.exitCode === null && proc.signalCode === null) {
    try {
      proc.kill("SIGKILL");
    } catch (ex) {}
  }
}

module.exports.screnshotForUrlTab = async function (
  url,
  headers,
  isfullPage,
  resX,
  resY,
  outFormat,
  orientation,
  waitTime,
  proxy_server,
  dismissModals,
) {
  try {
    waitTime = parseInt(waitTime);
    //prevent never finishing wait
    if (waitTime == 0) {
      waitTime = 1;
    }
  } catch (ex) {
    waitTime = 100;
  }

  var entry = acquireBrowser();
  var context = null;
  try {
    var browser = await entry.browser;
    //a private context per request: closing it closes the page and any popup it opened
    context = await browser.createIncognitoBrowserContext();
    var job = renderPage(context, url, headers, isfullPage, resX, resY, outFormat, orientation, waitTime, dismissModals);
    //the job keeps running after a timeout until its context is closed, ignore its late error
    job.catch(() => {});
    return await withTimeout(job, JOB_TIMEOUT_MS, "Screenshot timed out after " + JOB_TIMEOUT_MS + "ms");
  } catch (ex) {
    console.log("Error while taking screenshot: " + ex.message);
    console.log(ex);

    return {
      status: "error",
      details: ex.message,
      mimeType: "application/json",
    };
  } finally {
    if (context != null) {
      try {
        await withTimeout(context.close(), CLOSE_TIMEOUT_MS, "context.close() timed out");
      } catch (ex) {
        //chromium is not responding, replace it
        retireBrowser(entry);
      }
    }
    releaseBrowser(entry);
  }
};

async function renderPage(context, url, headers, isfullPage, resX, resY, outFormat, orientation, waitTime, dismissModals) {
  var buffer = null;

  const page = await context.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.159 Safari/537.36"
  );

  if (headers != null) {
    page.setExtraHTTPHeaders(headers).catch((ex) => console.log("Invalid headers: " + ex.message));
  }
  await page.goto(url);

  await page.setViewport({
    width: parseInt(resX),
    height: parseInt(resY),
    isMobile: false,
    deviceScaleFactor: 1,
  });

  //scroll the whole page for lazy loading
  if (isfullPage) {
    await autoScroll(page);
  }

  //wait for the page to be fully loaded - max 1000ms wait
  try {
    await page.waitForNavigation({
      waitUntil: "networkidle2",
      timeout: waitTime,
    });
  } catch (ex) {}

  //Try to dismiss modals by sending Tab and Esc
  if (dismissModals) {
    try {
      await page.focus("body");
      await page.keyboard.press('Escape');
      await page.waitForNavigation({
        timeout: 200,
      });
    } catch (ex) {}
  }

  var finalType = "jpg";
  var finalMime = "image/jpeg";

  if (outFormat == "jpg") {
    finalType = "jpeg";
    finalMime = "image/jpeg";
  } else if (outFormat == "png") {
    finalType = "png";
    finalMime = "image/png";
  } else if (outFormat == "pdf") {
    finalType = "pdf";
    finalMime = "application/pdf";
  }

  var optionsPup = {
    type: finalType,
    encoding: "binary",
    fullPage: isfullPage,
  };

  if (finalType == "jpeg") {
    optionsPup.quality = 88;
  }

  if (finalType != "pdf") {
    buffer = await page.screenshot(optionsPup);
  } else {
    buffer = await page.pdf({
      printBackground: true,
      scale: 1,
      format: "A4",
      landscape: orientation === "landscape",
    });
  }

  return {
    mimeType: finalMime,
    data: buffer,
  };
}

module.exports.CleanMemory = async function () {
  await CleanMem();
};

async function CleanMem() {
  if (current != null) {
    retireBrowser(current);
  }
}

module.exports.screnshotForUrl = async function (
  url,
  isfullPage,
  resX,
  resY,
  outFormat,
  waitTime
) {
  return new Promise(async function (resolve, reject) {
    try {
      waitTime = parseInt(waitTime);
      //prevent never finishing wait
      if (waitTime == 0) {
        waitTime = 1;
      }
    } catch (ex) {
      waitTime = 100;
    }

    var timestamp = +new Date();
    var buffer = null;
    var browser = null;
    try {
      browser = await puppeteer.launch({
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage();

      var errorContent = "";
      await page.goto(url).catch((e) => (errorContent = e));

      //display error in the image
      if (errorContent != "") {
        page.setContent("<pre>" + errorContent.stack + "</pre>");
      }

      await page.setViewport({
        width: parseInt(resX),
        height: parseInt(resY),
        isMobile: false,
        deviceScaleFactor: 1,
      });

      //scroll the whole page for lazy loading
      await autoScroll(page);

      //wait for the page to be fully loaded - max 1000ms wait
      try {
        await page.waitForNavigation({
          waitUntil: "networkidle2",
          timeout: waitTime,
        });
      } catch (ex) {}

      var finalType = "jpg";
      var finalMime = "image/jpeg";

      if (outFormat == "jpg") {
        finalType = "jpeg";
        finalMime = "image/jpeg";
      } else if (outFormat == "png") {
        finalType = "png";
        finalMime = "image/png";
      } else if (outFormat == "pdf") {
        finalType = "pdf";
        finalMime = "application/pdf";
      }

      buffer = await page.screenshot({
        type: finalType,
        quality: 84,
        encoding: "binary",
        fullPage: isfullPage,
      });
      await browser.close();

      let mimeType = finalMime;
      var resp = {
        mimeType: mimeType,
        data: buffer,
      };

      resolve(resp);
    } catch (ex) {
      console.log("Error while taking screenshot: " + ex.message);
      console.log(ex);

      try {
        await browser.close();
      } catch (ex) {}

      var resp = {
        status: "error",
        details: ex,
        mimeType: "application/json",
      };
      reject(resp);
    }
  });
};

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      let totalHeight = 0;
      let distance = 200;
      let timer = setInterval(() => {
        let scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
  });
}

module.exports.sleep = function (ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// API Key for authentication
const API_KEY = process.env.API_KEY || 'your-secret-api-key-here';

// Load proxies from JSON file
let residentialProxies = [];
const PROXY_FILE_PATH = path.join(__dirname, 'proxies.json');

function loadProxies() {
  try {
    if (fs.existsSync(PROXY_FILE_PATH)) {
      const data = fs.readFileSync(PROXY_FILE_PATH, 'utf8');
      const parsedData = JSON.parse(data);
      residentialProxies = parsedData.proxies || [];
      console.log(`[INFO] Loaded ${residentialProxies.length} proxies from proxies.json`);
    } else {
      console.log('[WARNING] proxies.json not found, using default empty proxy list');
      residentialProxies = [];
    }
  } catch (error) {
    console.error('[ERROR] Failed to load proxies:', error.message);
    residentialProxies = [];
  }
}

// Function to add a delay in milliseconds
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchHeaders() {
  let browser;
  let totalSent = 0; // Track total data sent in bytes
  let totalReceived = 0; // Track total data received in bytes
  const eventId = '00006142CB7477BC'; // Default event ID

  try {
    // **Randomly select a residential proxy**
    const proxy = residentialProxies[Math.floor(Math.random() * residentialProxies.length)];
    const proxyWithoutProtocol = proxy.replace('http://', '');
    const [proxyAuth, proxyAddress] = proxyWithoutProtocol.split('@');
    const [username, password] = proxyAuth.split(':');

    console.log(`[DEBUG] Using proxy: ${proxyAddress}`);

    // **Launch Puppeteer with proxy settings**
    browser = await puppeteer.launch({
      headless: false, // Use headless mode for production
      args: [
        `--proxy-server=${proxyAddress}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-images',
        '--disable-webgl',
        '--blink-settings=imagesEnabled=false',
        '--disable-extensions',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-webrtc',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad'
      ],
      timeout: 60000
    });

    const page = await browser.newPage();

    // **Set proxy authentication**
    await page.authenticate({
      username: username,
      password: password
    });

    // **Set a specific User-Agent**
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
    console.log(`[DEBUG] Using User-Agent: ${userAgent}`);
    await page.setUserAgent(userAgent);

    // **Set up Chrome DevTools Protocol (CDP) for network monitoring**
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');

    // **Track data sent**
    client.on('Network.requestWillBeSent', (event) => {
      const { request } = event;
      const { method, url, headers, postData } = request;

      try {
        const parsedUrl = new URL(url);
        const path = parsedUrl.pathname + parsedUrl.search;
        const requestLine = `${method} ${path} HTTP/1.1\r\n`;

        let headersSize = 0;
        for (const [key, value] of Object.entries(headers)) {
          headersSize += `${key}: ${value}\r\n`.length;
        }
        headersSize += 2; // Account for the extra CRLF at the end of headers

        const postDataSize = postData ? postData.length : 0;
        const requestSize = requestLine.length + headersSize + postDataSize;
        totalSent += requestSize;
      } catch (error) {
        console.error('[ERROR] Failed to calculate request size:', error.message);
      }
    });

    // **Track data received**
    client.on('Network.dataReceived', (event) => {
      totalReceived += event.dataLength;
    });

    // Create a promise to capture the quickpicks request
    let targetHeaders = null;
    const targetXHRPattern = new RegExp(`^https:\\/\\/services\\.ticketmaster\\.com\\/api\\/ismds\\/event\\/${eventId}\\/quickpicks`);
    
    // Function to create a promise that will resolve when the target request is found
    const createXHRPromise = () => {
      return new Promise((resolve) => {
        page.on('request', async (request) => {
          const url = request.url();
          if (targetXHRPattern.test(url) && request.resourceType() === 'xhr') {
            console.log('[SUCCESS] XHR request detected!');
            console.log(`[RESULT] XHR URL: ${url}`);
            
            // Extract headers
            targetHeaders = request.headers();
            resolve(true);
          }
        });
      });
    };
    
    // Create the promise before navigating
    const xhrPromise = createXHRPromise();

    // **Navigate to DuckDuckGo Lite**
    console.log('[DEBUG] Navigating to DuckDuckGo Lite...');
    await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'networkidle2' });
    console.log('[DEBUG] DuckDuckGo Lite page loaded');

    // **Enter the search query into the search bar**
    const searchInputSelector = 'input.query';
    await page.waitForSelector(searchInputSelector, { visible: true, timeout: 15000 });
    await page.type(searchInputSelector, eventId);

    // **Click the search button**
    const searchButtonSelector = 'input.submit';
    await page.waitForSelector(searchButtonSelector, { visible: true, timeout: 15000 });
    await page.click(searchButtonSelector);

    // **Wait for the search results page to load**
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    console.log('[DEBUG] Search results loaded');

    // **Find and click the Ticketmaster link with seat map blocking**
    console.log('[DEBUG] Clicking the Ticketmaster link...');
    const ticketmasterLinkSelector = 'a[href*="ticketmaster.com"]';
    const ticketmasterLink = await page.waitForSelector(ticketmasterLinkSelector, { visible: true, timeout: 10000 });
    if (!ticketmasterLink) {
      console.log('[ERROR] Ticketmaster link not found on DuckDuckGo Lite page.');
      throw new Error('Ticketmaster link not found');
    }

    // Enable request interception to block seat map resources on Ticketmaster
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url().toLowerCase();
      if (url.includes('mapsapi.tmol.io') && url.includes('ticketmaster.com')) {
        console.log(`[DEBUG] Blocking seat map request: ${url}`);
        request.abort();
      } else {
        request.continue();
      }
    });

    await Promise.all([
      ticketmasterLink.click(),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 })
    ]);
    console.log('[DEBUG] Successfully navigated to Ticketmaster page.');

    // **Handle interactions on the Ticketmaster page**
    const handleTicketmasterPage = async (page) => {
      const acceptButtonSelector = 'button[data-bdd="accept-modal-accept-button"]';
      const filterButtonSelector = '#edp-quantity-filter-button';
      const applyFiltersButtonSelector = 'button[data-bdd="applyFilterBtn"]';

      console.log('[DEBUG] Waiting for Ticketmaster page to fully load...');
      await page.waitForSelector('body', { timeout: 15000 });
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 });
      await delay(3000);

      // Click "Accept & Continue" button if present
      try {
        const acceptButton = await page.$(acceptButtonSelector);
        if (acceptButton) {
          console.log('[DEBUG] Clicking "Accept & Continue" button...');
          await acceptButton.click();
          await delay(2000);
        }
      } catch (error) {
        console.log('[ERROR] Issue clicking "Accept & Continue" button:', error.message);
      }

      // Click the filter button
      try {
        await page.waitForSelector(filterButtonSelector, { visible: true, timeout: 10000 });
        console.log('[DEBUG] Clicking the filter button...');
        await page.click(filterButtonSelector);
      } catch (error) {
        console.log('[ERROR] Filter button not found or not clickable.');
        return;
      }

      // Wait before applying filters
      await delay(1500);

      // Click the "Apply Filters" button
      try {
        await page.waitForSelector(applyFiltersButtonSelector, { visible: true, timeout: 5000 });
        console.log('[DEBUG] Clicking the "Apply Filters" button...');
        await page.click(applyFiltersButtonSelector);
      } catch (error) {
        console.log('[ERROR] "Apply Filters" button not found.');
        return;
      }
    };

    await handleTicketmasterPage(page);
    
    // Wait for the XHR to be captured or timeout
    const xhrFound = await Promise.race([
      xhrPromise,
      new Promise(resolve => setTimeout(() => resolve(false), 30000))
    ]);
    
    if (!xhrFound || !targetHeaders) {
      throw new Error('Failed to capture the /quickpicks request headers');
    }

    // Extract cookies for header format
    const cookies = await page.cookies();
    const cookieString = cookies
      .filter(cookie => cookie.domain.includes('ticketmaster'))
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');

    // Create final headers object
    const headersObject = { ...targetHeaders };
    headersObject['Cookie'] = cookieString;
    
    // Log metrics
    console.log('[RESULT] Total data sent:', (totalSent / 1024 / 1024).toFixed(2), 'MB');
    console.log('[RESULT] Total data received:', (totalReceived / 1024 / 1024).toFixed(2), 'MB');
    
    return { 
      success: true, 
      headers: headersObject
    };
  } catch (error) {
    console.error(`[ERROR] Failed to fetch headers:`, error.message);
    return { 
      success: false, 
      error: error.message 
    };
  } finally {
    if (browser) {
      await browser.close();
      console.log('[DEBUG] Browser closed');
    }
  }
}

// Authentication middleware
function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or missing API key'
    });
  }
  
  next();
}

// API endpoint to fetch headers
app.get('/api/headers', authenticateApiKey, async (req, res) => {
  try {
    console.log('[INFO] Received request for headers');
    
    // Check if we have proxies loaded
    if (residentialProxies.length === 0) {
      return res.status(503).json({
        success: false,
        error: 'No proxies available'
      });
    }
    
    const result = await fetchHeaders();
    
    if (result.success) {
      res.json({
        success: true,
        headers: result.headers
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }
  } catch (error) {
    console.error('[ERROR] Error handling request:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Load proxies on startup
loadProxies();

// API endpoint to reload proxies
app.post('/api/reload-proxies', authenticateApiKey, (req, res) => {
  try {
    loadProxies();
    res.json({
      success: true,
      message: `Reloaded ${residentialProxies.length} proxies`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`[INFO] Server running on port ${PORT}`);
});
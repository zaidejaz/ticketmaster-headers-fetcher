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

// Function to handle BartProxies format specifically
function parseBartProxy(proxyUrl) {
  // Remove protocol if exists
  let cleanProxy = proxyUrl;
  if (proxyUrl.includes('://')) {
    cleanProxy = proxyUrl.split('://')[1];
  }

  // Split auth and address
  const [proxyAuth, proxyAddress] = cleanProxy.split('@');
  const [username, password] = proxyAuth.split(':');

  return { username, password, proxyAddress };
}

async function fetchEventHeaders(eventId) {
  let browser;
  // Select a random proxy from the list
  const proxy = residentialProxies[Math.floor(Math.random() * residentialProxies.length)];
  
  try {
    // Parse the proxy information
    const { username, password, proxyAddress } = parseBartProxy(proxy);

    console.log(`[DEBUG] Using proxy: ${proxyAddress}`);

    // Configure launch options
    const launchOptions = {
      headless: 'new', // Use new headless mode
      executablePath: process.env.CHROME_PATH || undefined,
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
        '--disable-breakpad',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--disable-gpu',
        '--mute-audio'
      ],
      timeout: 60000
    };

    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    
    // Set up proxy authentication
    await page.authenticate({ username, password });

    // Set up request monitoring for capturing both request and response headers
    let targetRequestHeaders = null;
    let targetResponseHeaders = null;
    let foundTargetRequest = false;
    
    // Using CDP session for more reliable network monitoring
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    
    // Monitor request headers
    client.on('Network.requestWillBeSent', event => {
      const { request } = event;
      const url = request.url;
      
      if (url.includes(`/event/${eventId}/quickpicks`)) {
        foundTargetRequest = true;
        targetRequestHeaders = request.headers;
        console.log(`[DEBUG] Captured request headers for: ${url}`);
      }
    });
    
    // Monitor response headers
    client.on('Network.responseReceived', event => {
      const { response } = event;
      const url = response.url;
      
      if (url.includes(`/event/${eventId}/quickpicks`)) {
        targetResponseHeaders = response.headers;
        console.log(`[DEBUG] Captured response headers for: ${url}`);
      }
    });

    console.log(`[DEBUG] Navigating to Ticketmaster...`);
    await page.goto('https://www.ticketmaster.com/', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Check for CAPTCHA
    const hasCaptcha = await page.evaluate(() => {
      return (
        document.body.textContent.includes('CAPTCHA') ||
        document.body.textContent.includes('robot') ||
        document.body.textContent.includes('verify you are human') ||
        !!document.querySelector('iframe[src*="recaptcha"]') ||
        !!document.querySelector('iframe[src*="challenges"]')
      );
    });
    
    if (hasCaptcha) {
      console.log('[WARNING] CAPTCHA detected! Trying to bypass...');
      // Wait a bit for any automatic CAPTCHA handling by Stealth Plugin
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    console.log(`[DEBUG] Triggering XHR request...`);
    await page.evaluate((eventId) => {
      fetch(`https://services.ticketmaster.com/api/ismds/event/${eventId}/quickpicks`, {
        method: 'GET',
        credentials: 'include'
      });
    }, eventId);

    // Wait for the request to be captured
    console.log(`[DEBUG] Waiting for response...`);
    const waitStartTime = Date.now();
    
    // Wait up to 10 seconds for the target request to be captured
    while (!foundTargetRequest && Date.now() - waitStartTime < 10000) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    if (!foundTargetRequest) {
      console.log(`[DEBUG] Target request not captured, trying alternative approach...`);
      
      // Try visiting the event page directly
      const eventUrl = `https://www.ticketmaster.com/event/${eventId}`;
      console.log(`[DEBUG] Navigating to event page: ${eventUrl}`);
      
      await page.goto(eventUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000
      });
      
      // Wait a bit more for any XHR requests
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // If still not found, try manually triggering it again
      if (!foundTargetRequest) {
        console.log(`[DEBUG] Target request still not found, forcing XHR request...`);
        
        await page.evaluate((eventId) => {
          fetch(`https://services.ticketmaster.com/api/ismds/event/${eventId}/quickpicks?show=places+maxQuantity+sections&mode=primary&qty=2&includeStandard=true`, {
            method: 'GET',
            credentials: 'include',
            headers: {
              'accept': '*/*',
              'accept-language': 'en-US,en;q=0.9',
              'referer': 'https://www.ticketmaster.com/',
              'sec-fetch-dest': 'empty',
              'sec-fetch-mode': 'cors',
              'sec-fetch-site': 'same-site'
            }
          });
        }, eventId);
        
        // Wait again for request capture
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // Extract cookies for the header format
    const cookies = await page.cookies();
    const cookieString = cookies
      .filter(cookie => cookie.domain.includes('ticketmaster'))
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
    
    if (!foundTargetRequest || !targetRequestHeaders) {
      throw new Error('Failed to capture the target request headers');
    }
    
    // Create final headers object
    const headersObject = { ...targetRequestHeaders };
    
    // Update the cookie header (ensure only lowercase 'cookie' is used)
    headersObject['cookie'] = cookieString;
    if (headersObject['Cookie']) {
      delete headersObject['Cookie'];
    }
    
    return { 
      success: true, 
      headers: headersObject
    };
  } catch (error) {
    console.error(`[ERROR] Failed to fetch headers using proxy ${proxy}:`, error.message);
    return { 
      success: false, 
      error: error.message 
    };
  } finally {
    if (browser) {
      await browser.close();
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
    
    // Get event ID from query or use default
    const eventId = req.query.eventId || '00006142CB7477BC';
    
    const result = await fetchEventHeaders(eventId);
    
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

// API endpoint to fetch headers for direct usage (no authentication)
app.get('/public/headers', async (req, res) => {
  try {
    console.log('[INFO] Received public request for headers');
    
    // Check if we have proxies loaded
    if (residentialProxies.length === 0) {
      return res.status(503).json({
        success: false,
        error: 'No proxies available'
      });
    }
    
    // Get event ID from query or use default
    const eventId = req.query.eventId || '00006142CB7477BC';
    
    const result = await fetchEventHeaders(eventId);
    
    if (result.success) {
      // Return just the headers for direct usage (no wrapping)
      res.json(result.headers);
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

// Test proxy endpoint
app.get('/api/test-proxy', authenticateApiKey, async (req, res) => {
  let browser;
  try {
    // Get specific proxy index or use random
    const proxyIndex = req.query.index ? parseInt(req.query.index, 10) : Math.floor(Math.random() * residentialProxies.length);
    
    if (proxyIndex >= residentialProxies.length) {
      return res.status(400).json({
        success: false,
        error: `Invalid proxy index: ${proxyIndex}. Max index is ${residentialProxies.length - 1}`
      });
    }
    
    const proxy = residentialProxies[proxyIndex];
    const { username, password, proxyAddress } = parseBartProxy(proxy);
    
    console.log(`[DEBUG] Testing proxy ${proxyIndex}: ${proxyAddress}`);
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        `--proxy-server=${proxyAddress}`,
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });
    
    const page = await browser.newPage();
    await page.authenticate({ username, password });
    
    // Check IP
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle2' });
    const ipData = await page.evaluate(() => {
      return JSON.parse(document.body.textContent);
    });
    
    await browser.close();
    
    res.json({
      success: true,
      proxy: {
        index: proxyIndex,
        address: proxyAddress,
        username: username
      },
      ip: ipData.ip
    });
  } catch (error) {
    console.error('[ERROR] Error testing proxy:', error);
    if (browser) await browser.close();
    
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
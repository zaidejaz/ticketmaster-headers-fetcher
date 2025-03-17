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

async function fetchHeaders() {
    let browser;
    // Select a random proxy from the list
    const proxy = residentialProxies[Math.floor(Math.random() * residentialProxies.length)];
    
    try {
        const proxyWithoutProtocol = proxy.replace('http://', '');
        const [proxyAuth, proxyAddress] = proxyWithoutProtocol.split('@');
        const [username, password] = proxyAuth.split(':');

        console.log(`[DEBUG] Using proxy: ${proxyAddress}`);

        browser = await puppeteer.launch({
            headless: 'new', // Use new headless mode for better performance
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
            timeout: 60000,
            defaultViewport: { width: 1280, height: 800 }
        });

        const page = await browser.newPage();
        
        // Set authentication for the proxy
        await page.authenticate({ username, password });
        
        // Minimize bandwidth by blocking unnecessary resources
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const resourceType = request.resourceType();
            // Only allow document, xhr, fetch, and script resources
            if (['document', 'xhr', 'fetch', 'script'].includes(resourceType)) {
                request.continue();
            } else {
                request.abort();
            }
        });

        // Set up listeners for XHR requests before navigation
        let quickpicksHeaders = null;
        const requestListener = async request => {
            if (request.url().includes('/quickpicks')) {
                const headers = request.headers();
                console.log(`[DEBUG] Captured request headers for ${request.url()}`);
                quickpicksHeaders = headers;
            }
        };
        
        page.on('request', requestListener);

        // Set up response listener
        const responsePromise = new Promise(resolve => {
            page.on('response', async response => {
                if (response.url().includes('/quickpicks')) {
                    console.log(`[DEBUG] Captured response from ${response.url()}`);
                    const responseHeaders = response.headers();
                    resolve({ responseHeaders, url: response.url() });
                }
            });
        });

        console.log(`[DEBUG] Navigating to Ticketmaster...`);
        await page.goto('https://www.ticketmaster.com/', {
            waitUntil: 'domcontentloaded', // Use domcontentloaded instead of load to speed up
            timeout: 60000
        });

        console.log(`[DEBUG] Page loaded, triggering XHR request...`);
        
        // Wait for the page to be more stable before triggering the request
        // Using setTimeout instead of page.waitForTimeout for compatibility
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Trigger the XHR request
        const result = await page.evaluate(async () => {
            try {
                const response = await fetch(`https://services.ticketmaster.com/api/ismds/event/00006142CB7477BC/quickpicks`, {
                    method: 'GET',
                    credentials: 'include'
                });
                
                return { success: true };
            } catch (error) {
                return { success: false, error: error.toString() };
            }
        });
        
        if (!result.success) {
            console.error(`[ERROR] Failed to execute fetch in page context: ${result.error}`);
        }
        
        // Wait for the response with a timeout
        const responseData = await Promise.race([
            responsePromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Response timeout')), 15000))
        ]);
        
        // Extract cookies for header format
        const cookies = await page.cookies();
        const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        
        // Combine request and response headers
        const headersObject = {
            ...(quickpicksHeaders || {}),
            ...responseData.responseHeaders,
            'Cookie': cookieString
        };
        
        return { 
            success: true, 
            headers: headersObject,
            url: responseData.url
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
        
        // Allow custom event ID via query parameter
        const eventId = req.query.eventId || '00006142CB7477BC';
        
        const result = await fetchHeaders(eventId);
        
        if (result.success) {
            res.json({
                success: true,
                headers: result.headers,
                url: result.url
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
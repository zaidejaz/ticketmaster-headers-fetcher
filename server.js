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
            headless: true, // Set to true for production
            executablePath: process.env.CHROME_PATH || undefined, // Allow custom Chrome path
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
            timeout: 60000,
            ignoreDefaultArgs: ['--disable-extensions']
        });

        const page = await browser.newPage();
        await page.authenticate({ username, password });

        console.log(`[DEBUG] Navigating to Ticketmaster...`);
        await page.goto('https://www.ticketmaster.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        console.log(`[DEBUG] Triggering XHR request...`);
        await page.evaluate(() => {
            fetch(`https://services.ticketmaster.com/api/ismds/event/00006142CB7477BC/quickpicks`, {
                method: 'GET',
                credentials: 'include'
            });
        });

        const response = await page.waitForResponse(response =>
            response.url().includes('/quickpicks'),
            { timeout: 60000 }
        );

        // Extract headers
        const headers = response.headers();
        
        // Extract cookies for header format
        const cookies = await page.cookies();
        const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        
        // Create final headers object
        const headersObject = { ...headers };
        headersObject['Cookie'] = cookieString;
        
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
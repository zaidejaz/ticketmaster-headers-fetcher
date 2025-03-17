const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// Function to add a delay in milliseconds
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Function to load proxies from JSON file
const loadProxiesFromFile = () => {
  try {
    const proxyFilePath = path.join(__dirname, 'proxies.json');
    if (fs.existsSync(proxyFilePath)) {
      const data = fs.readFileSync(proxyFilePath, 'utf8');
      const parsedData = JSON.parse(data);
      
      if (parsedData && parsedData.proxies && Array.isArray(parsedData.proxies)) {
        console.log(`[INFO] Loaded ${parsedData.proxies.length} proxies from proxies.json`);
        return parsedData.proxies;
      }
    }
  } catch (error) {
    console.error('[ERROR] Failed to load proxies from file:', error.message);
  }
  
  return [];
};

// Function to construct a full CURL command from a request
const constructFullCurlCommand = (request) => {
    const method = request.method();
    const url = request.url();
    const headers = request.headers();
    const postData = request.postData() || '';

    let curl = `curl -X ${method} '${url}' \\\n`;

    for (const [key, value] of Object.entries(headers)) {
        curl += `    -H '${key}: ${value}' \\\n`;
    }

    if (postData) {
        curl += `    --data-raw '${postData}' \\\n`;
    }

    curl += `    --compressed`;

    return curl;
};

// Main header fetcher function
const headerFetcher = async (eventId = '00006142CB7477BC', customProxies = []) => {
    let browser;
    let totalSent = 0; // Track total data sent in bytes
    let totalReceived = 0; // Track total data received in bytes
    let capturedHeaders = null;

    try {
        // Load proxies from file or use provided custom proxies
        const residentialProxies = customProxies.length > 0 ? customProxies : loadProxiesFromFile();
        
        // **Randomly select a residential proxy**
        const randomProxy = residentialProxies[Math.floor(Math.random() * residentialProxies.length)];
        const proxyParts = randomProxy.split('@');
        const proxyAddress = `http://${proxyParts[1]}`;
        const proxyAuth = proxyParts[0].split(':');

        console.log(`[DEBUG] Using proxy: ${proxyAddress}`);

        // **Launch Puppeteer with proxy settings**
        browser = await puppeteer.launch({
            headless: 'new', // Use headless mode for production
            args: [`--proxy-server=${proxyAddress}`, '--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        // **Set proxy authentication**
        await page.authenticate({
            username: proxyAuth[0],
            password: proxyAuth[1]
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

        // Create a promise to capture the target request
        const headerCapturePromise = new Promise(resolve => {
            const targetXHRPattern = new RegExp(`^https:\\/\\/services\\.ticketmaster\\.com\\/api\\/ismds\\/event\\/${eventId}\\/quickpicks`);

            page.on('request', async (request) => {
                const url = request.url();

                if (targetXHRPattern.test(url) && request.resourceType() === 'xhr') {
                    console.log('[SUCCESS] XHR request detected!');
                    console.log(`[RESULT] XHR URL: ${url}`);

                    // Get headers
                    capturedHeaders = request.headers();
                    
                    // Generate and log the full CURL command
                    const curlCommand = constructFullCurlCommand(request);
                    console.log('[SUCCESS] Generated CURL Command');

                    resolve(true);
                }
            });
        });

        // **Navigate to DuckDuckGo Lite**
        console.log('[DEBUG] Navigating to DuckDuckGo Lite...');
        await page.goto('https://lite.duckduckgo.com/lite/', { waitUntil: 'networkidle2' });
        console.log('[DEBUG] DuckDuckGo Lite page loaded');

        // **Enter the search query into the search bar**
        const searchInputSelector = 'input.query';
        await page.waitForSelector(searchInputSelector, { visible: true, timeout: 5000 });
        await page.type(searchInputSelector, eventId);

        // **Click the search button**
        const searchButtonSelector = 'input.submit';
        await page.waitForSelector(searchButtonSelector, { visible: true, timeout: 5000 });
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
                console.log('[ERROR] Filter button not found or not clickable: ' + error.message);
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
                console.log('[ERROR] "Apply Filters" button not found: ' + error.message);
                return;
            }
        };

        await handleTicketmasterPage(page);
        
        // Wait for XHR request to be captured or timeout after 20 seconds
        const xhrCaptured = await Promise.race([
            headerCapturePromise,
            new Promise(resolve => setTimeout(() => resolve(false), 20000))
        ]);

        if (!xhrCaptured || !capturedHeaders) {
            throw new Error('Failed to capture headers within timeout period');
        }
        
        // Get cookies for the Cookie header
        const cookies = await page.cookies();
        const cookieString = cookies
            .filter(cookie => cookie.domain.includes('ticketmaster'))
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
        
        // Add Cookie header to the captured headers
        capturedHeaders['cookie'] = cookieString;

        // Log total data usage
        console.log('[RESULT] Total data sent:', (totalSent / 1024 / 1024).toFixed(2), 'MB');
        console.log('[RESULT] Total data received:', (totalReceived / 1024 / 1024).toFixed(2), 'MB');
        
        return {
            success: true,
            headers: capturedHeaders
        };

    } catch (error) {
        console.error('[ERROR] An error occurred:', error.message);
        return {
            success: false,
            error: error.message
        };
    } finally {
        if (browser) {
            // Close the browser
            console.log('[DEBUG] Closing browser...');
            await browser.close();
            console.log('[DEBUG] Browser closed successfully');
        }
    }
};

module.exports = {
    headerFetcher
};
# Header Fetcher API

A secure API service that fetches HTTP headers from Ticketmaster using residential proxies.

## Features

- API key authentication for secure access
- Dynamically loaded proxies from a JSON file
- Clean JSON response format for easy integration
- Systemd service setup for reliability
- GitHub Actions workflow for automated deployment

## Setup Instructions

### Local Development

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file with:
   ```
   API_KEY=your-secret-api-key-here
   PORT=3000
   ```
4. Start the development server:
   ```
   npm run start
   ```

### Production Deployment

The repository includes GitHub Actions that will copy files to your server. After files are copied:

1. SSH into your server
2. Navigate to the application directory:
   ```
   cd /opt/header-fetcher
   ```
3. Run the deployment script:
   ```
   ./deploy.sh
   ```

### GitHub Actions Configuration

Add the following secrets to your GitHub repository:

- `SSH_PRIVATE_KEY`: Your private SSH key for server access
- `SERVER_IP`: Your server's IP address
- `SSH_USER`: SSH username for your server

## API Usage

### Fetch Headers

```
GET /api/headers?apiKey=your-api-key
```

Or use an HTTP header:

```
GET /api/headers
X-API-Key: your-api-key
```

### Response Format

```json
{
  "success": true,
  "headers": {
    "content-type": "application/json",
    "cache-control": "no-cache",
    "... other headers": "...",
    "Cookie": "name1=value1; name2=value2; ..."
  }
}
```

### Reload Proxies

```
POST /api/reload-proxies
X-API-Key: your-api-key
```

## Proxy Configuration

Update the `proxies.json` file with your residential proxies:

```json
{
  "proxies": [
    "http://username:password@proxy-server:port",
    "..."
  ]
}
```

## Security Considerations

- Keep your API key secure
- Regularly rotate proxies in `proxies.json`
- Monitor server logs for unauthorized access attempts
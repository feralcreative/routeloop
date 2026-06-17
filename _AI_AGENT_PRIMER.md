# AI Agent Primer: Moto-Rooter

**Last Updated:** 2026-01-22  
**Project:** Motorcycle Route Visualization Framework  
**Repository:** https://github.com/feralcreative/moto-rooter.git

---

## 🔒 SECRETS REFERENCE GUIDE

### 1. Google Maps API Key

**Location:** `.env` (line 1)  
**Format:** `GOOGLE_MAPS_API_KEY=AIza...FsY` (39 characters)  
**Usage:** Required for Google Maps JavaScript API integration  
**Note:** This key is injected into HTML files at runtime by the Express server

### 2. Server Port

**Location:** `.env` (line 2)  
**Value:** `6686`  
**Usage:** Express server listens on this port for local development

### 3. Production Deployment Path

**Location:** `ecosystem.config.js` (line 6)  
**Path:** `/volume1/web/moto-rooter.feralcreative.dev`  
**Usage:** PM2 deployment path on Synology NAS

---

## ARCHITECTURE & STRUCTURE

### Technology Stack

- **Runtime:** Node.js (version not specified in package.json)
- **Server:** Express 4.19.2
- **Template Engine:** Nunjucks 3.2.4 (for API key injection)
- **Environment:** dotenv 16.6.1
- **Process Manager:** PM2 (via ecosystem.config.js)
- **Frontend:** Vanilla JavaScript (no framework)
- **Maps:** Google Maps JavaScript API (beta, with maps & geometry libraries)
- **Styling:** SCSS → CSS (compiled via VS Code Live Sass Compile extension)

### Directory Structure

```text
/
├── .augment/                    # Augment AI configuration (symlinked)
├── .env                         # Environment variables (GITIGNORED)
├── .env.example                 # Template for environment setup
├── .gitignore                   # Comprehensive ignore rules
├── .htpasswd                    # HTTP basic auth credentials
├── demo/                        # Demo/template directory
│   └── img/                     # Demo-specific images (logos)
├── ecosystem.config.js          # PM2 process configuration
├── favicon.ico                  # Site favicon
├── img/                         # Static assets
│   ├── colors/                  # Route color swatches
│   ├── icons/                   # Waypoint SVG icons (24 types)
│   ├── crater-lake.jpg          # Background image
│   ├── dl.svg                   # Download icon
│   ├── link.svg                 # Link icon
│   └── [various app icons]      # PWA/mobile icons
├── index.html                   # Root landing page (minimal)
├── manifest.json                # PWA manifest
├── node_modules/                # Dependencies (GITIGNORED)
├── package.json                 # Project metadata & scripts
├── package-lock.json            # Dependency lock file
├── README.md                    # Comprehensive documentation
├── server.js                    # Express server with API key injection
└── style/                       # Stylesheets
    ├── main.scss                # Source SCSS (556 lines)
    ├── main.css                 # Compiled CSS
    ├── main.min.css             # Minified CSS
    └── *.css.map                # Source maps
```

### Missing Directories (Referenced but Not Present)

- `/js/` - JavaScript files (mentioned in README, not yet created)
- `/data/` - Route data files (.kml, .gpx, .url, routes.json)

---

## ENTRY POINTS & DATA FLOW

### 1. Server Entry Point

**File:** `server.js`  
**Port:** 6686 (configurable via `.env`)

**Flow:**

1. Loads environment variables from `.env`
2. Configures Nunjucks template engine
3. Sets up static file serving for `/js`, `/style`, `/img`, `/data`
4. Intercepts HTML requests
5. Reads HTML files directly
6. Replaces `{{ GOOGLE_MAPS_API_KEY }}` placeholders with actual API key
7. Serves processed HTML

**Key Routes:**

- `GET /*` - Dynamic HTML processing with API key injection
- `GET /test` - Nunjucks template rendering test
- Static routes for assets

### 2. Frontend Entry Point (Planned)

**File:** `/js/main.js` (not yet created, but documented in README)
**Callback:** `initMap()` - Called by Google Maps API after loading

---

## CODE STRUCTURE (Planned/Documented)

### Core JavaScript Functions (from README)

**Location:** `/js/main.js` (not yet implemented)

#### `initMap()`

- **Purpose:** Entry point called by Google Maps API
- **Responsibilities:**
  - Initialize Google Map instance
  - Configure map appearance
  - Load routes from `data/routes.json`
  - Call `loadKmlRoute()` for each route
  - Build UI components

#### `loadKmlRoute(routeData, index)`

- **Purpose:** Load and render a single KML route
- **Responsibilities:**
  - Fetch KML file from `/data/`
  - Parse KML XML
  - Extract waypoints and path coordinates
  - Create Google Maps Polyline
  - Calculate route mileage using Geometry API
  - Add markers for waypoints
  - Apply route color from palette

#### `addRouteDownloadButtons()`

- **Purpose:** Generate download/link buttons for routes
- **Responsibilities:**
  - Build route table in info panel
  - Check for .gpx, .kml, .url files
  - Create download buttons
  - Set up click handlers
  - Apply route-specific colors

#### `updateRouteLegend()`

- **Purpose:** Update color-coded route legend
- **Responsibilities:**
  - Display route names with colors
  - Show route mileage
  - Enable route highlighting on hover

#### Helper Functions

- `getWaypointTitle(role)` - Determine waypoint display name from type
- `getColoredSvgIcon(iconPath, color, opacity)` - Generate colored SVG markers
- `setRouteHighlight(activeIndex)` - Highlight selected route
- `hexToRgba(hex, alpha)` - Color conversion utility

### Route Color Palette

**Location:** `/js/main.js` (search for `const colors = [`)

```javascript
const colors = [
  "#cc0000", // Red
  "#0000cc", // Blue
  "#DD00DD", // Magenta
  "#4A148C", // Purple
  "#00aaaa", // Cyan
  "#FF6F00", // Orange
  "#4E342E", // Brown
  "#006064", // Teal
  "#0D1335", // Dark Blue
  "#A0740B", // Mustard
  "#003300", // Dark Green
  "#550000", // Burgundy
  "#8800DD", // Violet
];
```

---

## FRONTEND ARCHITECTURE (Planned)

### Waypoint Icon System

**Location:** `/img/icons/`
**Format:** SVG with `currentColor` fill (for dynamic coloring)

#### Waypoint Naming Convention

Format: `TYPE - Waypoint Name` or `TYPE1/TYPE2/TYPE3 - Waypoint Name`

#### Waypoint Types (22 custom icons)

**Logistical:**

- START/BEGIN → icon-start.svg
- FINISH/END → icon-finish.svg
- HOME/HOUSE → icon-home.svg
- MEET/MEETUP/JOIN/MEETING/CONVERGE → icon-meet.svg
- SPLIT/DEPART/DIVERGE/LEAVE → icon-split.svg

**Journey Essentials:**

- GAS/FUEL → icon-gas.svg
- CHARGE/CHARGER → icon-charge.svg
- BREAK/REST → icon-break.svg

**Amenities:**

- CAMP/CAMPGROUND/CAMPING → icon-camp.svg
- HOTEL/LODGING/MOTEL/AIRBNB/SLEEP/STAY → icon-hotel.svg
- FOOD/LUNCH/DINNER/BREAKFAST → icon-food.svg
- COFFEE/CAFE → icon-coffee.svg
- DRINKS/BAR/COCKTAILS/BEER/BEERS → icon-drinks.svg
- GROCERY/GROCERIES → icon-grocery.svg

**Interesting:**

- VIEW/SCENIC/LOOKOUT/VIEWPOINT → icon-view.svg
- POI/STOP → icon-poi.svg
- WTF/WEIRD/RANDOM → icon-wtf.svg

**Standard (non-custom):**

- Manual waypoints → icon-waypoint-manual.svg (dot)
- Auto waypoints → icon-waypoint-auto.svg (smaller dot)

### Z-Index Hierarchy

| Value | Element                        | Purpose                          |
| ----- | ------------------------------ | -------------------------------- |
| 1001  | .map-logo                      | Map logo overlay (always on top) |
| 1000  | #info-panel                    | Info panel (fixed, bottom left)  |
| 100   | .collapse-toggle               | Collapse toggle button           |
| 11    | Marker (highlighted, custom)   | Custom marker during highlight   |
| 10    | Marker (custom)                | Custom role marker creation      |
| 2     | .panel-title (collapsed)       | Panel title in collapsed state   |
| 2     | Polyline (highlighted)         | Highlighted route line           |
| 2     | Marker (highlighted, standard) | Standard marker during highlight |
| 1     | .route-label:hover             | Route label hover effect         |
| 1     | Marker (standard)              | Standard waypoint marker         |
| 1     | Polyline (default)             | Route line stacking              |

---

## STYLING SYSTEM

### SCSS Architecture

**Source:** `style/main.scss` (556 lines)
**Compiled:** `style/main.css`, `style/main.min.css`
**Compiler:** VS Code Live Sass Compile extension (DO NOT compile manually)

### Color Variables

```scss
$url: #1565c0; // URL button color
$gpx: #43a047; // GPX button color
$kml: #d32f2f; // KML button color
$white: #fff;
$grey: #ddd;
$text: #333;
$panel-bg: rgba(255, 255, 255, 0.9);
$panel-shadow: rgba(0, 0, 0, 0.18);
$font: lato;
$panel-logo-size: 1em;
```

### External Dependencies

**Import:** `@import url("https://feralcreative.dev/utils.min.css");`
**Purpose:** Utility classes from external source

### Key Selectors

- `.crater-lake` - Full-screen background image
- `.gm-ui-hover-effect` - Hidden Google Maps UI element
- `div.map-logo` - Fixed position logo (top-left)
- `div.panel-logo` - Panel header logo
- `.waypoint-tooltip-*` - Waypoint tooltip styling
- `table.route-table` - Route download table
- `.btn-group` - Download button groups
- `.panel-content` - Collapsible panel content

---

## DATA STRUCTURE (Planned)

### routes.json Format

**Location:** `/data/routes.json` (not yet created)

```json
[{ "base": "01-Sample-Route-One" }, { "base": "02-Another-Route" }]
```

### Route Files

For each route with base name `01-Sample-Route-One`:

- **Required:** `01-Sample-Route-One.kml` - Route geometry
- **Optional:** `01-Sample-Route-One.gpx` - Downloadable GPS track
- **Optional:** `01-Sample-Route-One.url` - Plain text file with single URL

### KML Structure (Expected)

- Placemarks with LineString geometry (route paths)
- Placemarks with Point geometry (waypoints)
- Waypoint names follow naming convention for icon detection

---

## DEVELOPMENT WORKFLOW

### Local Setup

1. **Clone repository:**

   ```bash
   git clone https://github.com/feralcreative/moto-rooter.git
   cd moto-rooter
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Configure environment:**

   ```bash
   cp .env.example .env
   # Edit .env and add your Google Maps API key
   ```

4. **Start development server:**

   ```bash
   npm run dev
   ```

   Server runs at `http://localhost:6686`

5. **SCSS Compilation:**
   - DO NOT run manual SCSS compilation
   - Use VS Code Live Sass Compile extension
   - Extension auto-compiles on save

### Production Deployment

**Method:** PM2 on Synology NAS

1. **Start with PM2:**

   ```bash
   pm2 start ecosystem.config.js
   ```

2. **Monitor:**

   ```bash
   pm2 status
   pm2 logs moto-rooter
   ```

3. **Restart:**
   ```bash
   pm2 restart moto-rooter
   ```

**Deployment Path:** `/volume1/web/moto-rooter.feralcreative.dev`
**Log Files:**

- Combined: `/volume1/web/logs/moto-rooter-combined.log`
- Output: `/volume1/web/logs/moto-rooter-out.log`
- Error: `/volume1/web/logs/moto-rooter-error.log`

### PM2 Configuration

**File:** `ecosystem.config.js`

```javascript
{
  name: "moto-rooter",
  script: "server.js",
  instances: 1,
  exec_mode: "fork",
  env: {
    NODE_ENV: "production",
    PORT: 6686
  },
  autorestart: true,
  max_memory_restart: "1G",
  max_restarts: 50,
  restart_delay: 5000
}
```

---

## AUTHENTICATION & CREDENTIALS

### HTTP Basic Auth

**Location:** `.htpasswd` (GITIGNORED)
**Purpose:** Protect production site with basic authentication
**Format:** Apache htpasswd format

---

## APIs & INTEGRATIONS

### Google Maps JavaScript API

**Version:** Beta
**Libraries:** maps, geometry
**Callback:** `initMap()`

**Script Tag (in HTML):**

```html
<script
  async
  defer
  src="https://maps.googleapis.com/maps/api/js?key={{ GOOGLE_MAPS_API_KEY }}&v=beta&libraries=maps,geometry&callback=initMap"></script>
```

**Key Features Used:**

- Map initialization and configuration
- KML layer rendering (custom implementation)
- Polyline drawing
- Marker placement with custom icons
- Geometry library for distance calculations

**Rate Limits:** Standard Google Maps API limits apply

---

## DEPLOYMENT

### Production Workflow

1. **Test locally:**

   ```bash
   npm run dev
   ```

2. **Deploy to NAS:**

   ```bash
   # SSH into NAS
   ssh user@nas-hostname

   # Navigate to deployment directory
   cd /volume1/web/moto-rooter.feralcreative.dev

   # Pull latest changes
   git pull origin main

   # Install dependencies (if package.json changed)
   npm install

   # Restart PM2 process
   pm2 restart moto-rooter
   ```

3. **Verify deployment:**
   ```bash
   pm2 logs moto-rooter --lines 50
   ```

### Environment Variables

**Production (.env on NAS):**

- `GOOGLE_MAPS_API_KEY` - Google Maps API key
- `PORT` - 6686
- `NODE_ENV` - production

**Security:** `.env` file is GITIGNORED and must be manually created on server

---

## ARCHITECTURAL DECISIONS

### Why Express + Nunjucks for a "Static" Site?

**Problem:** Need to inject Google Maps API key into HTML without exposing it in source code
**Solution:** Use Express server to dynamically replace `{{ GOOGLE_MAPS_API_KEY }}` placeholders
**Trade-off:** Requires Node.js server instead of pure static hosting
**Benefit:** API key stays in `.env` file, never committed to git

### Why Vanilla JavaScript?

**Decision:** No frontend framework (React, Vue, etc.)
**Rationale:**

- Simple use case (map rendering + UI)
- Minimal dependencies
- Easy to understand and modify
- Fast load times
- No build step for JavaScript

### Why SCSS?

**Decision:** Use SCSS instead of plain CSS
**Rationale:**

- Variables for colors and sizing
- Nesting for better organization
- Easier maintenance
- VS Code extension handles compilation automatically

### Why PM2?

**Decision:** Use PM2 for process management
**Rationale:**

- Auto-restart on crashes
- Log management
- Memory monitoring
- Production-ready process manager
- Works well on Synology NAS

---

## CRITICAL ISSUES & KNOWN LIMITATIONS

### 1. Missing Core JavaScript

**Status:** `/js/main.js` does not exist
**Impact:** Map functionality not implemented
**Workaround:** README documents expected structure
**Priority:** HIGH - Core functionality

### 2. Missing Data Directory

**Status:** `/data/` directory does not exist
**Impact:** No route data to display
**Workaround:** Create directory and add routes manually
**Priority:** HIGH - Required for functionality

### 3. CSS Files in Git

**Issue:** `.gitignore` excludes `*.css` but compiled CSS exists in repo
**Impact:** Compiled CSS is tracked in git
**Workaround:** None currently
**Priority:** LOW - Cosmetic issue

### 4. Package Lock in Git

**Issue:** `.gitignore` excludes `package-lock.json` but it exists in repo
**Impact:** Lock file is tracked despite gitignore
**Workaround:** None
**Priority:** LOW - May cause dependency conflicts

### 5. No Build Script for routes.json

**Status:** `data/build.sh` mentioned in README but doesn't exist
**Impact:** Manual maintenance of routes.json
**Workaround:** Edit routes.json manually
**Priority:** MEDIUM - Quality of life

---

## DEBUGGING

### Common Problems

#### 1. "Map not loading"

**Cause:** Invalid or missing Google Maps API key
**Solution:** Check `.env` file, verify API key is valid
**Check:** Browser console for API errors

#### 2. "Server won't start"

**Cause:** Port 6686 already in use
**Solution:**

```bash
lsof -i :6686
kill -9 <PID>
```

#### 3. "CSS changes not appearing"

**Cause:** SCSS not compiled
**Solution:** Ensure VS Code Live Sass Compile extension is running
**Check:** Look for `main.css` modification time

#### 4. "Routes not displaying"

**Cause:** Missing `/data/routes.json` or KML files
**Solution:** Create data directory and add route files
**Check:** Network tab in browser dev tools

### Log Locations

**Development:**

- Console output (stdout/stderr)

**Production:**

- `/volume1/web/logs/moto-rooter-combined.log`
- `/volume1/web/logs/moto-rooter-error.log`
- `/volume1/web/logs/moto-rooter-out.log`

### Health Check

```bash
# Check if server is running
curl http://localhost:6686

# Check PM2 status
pm2 status moto-rooter

# Check recent logs
pm2 logs moto-rooter --lines 20

# Check memory usage
pm2 monit
```

---

## NEXT STEPS & ROADMAP

### Immediate Priorities

1. **Create `/js/main.js`** - Implement core map functionality
2. **Create `/data/` directory** - Set up route data structure
3. **Implement `initMap()`** - Google Maps initialization
4. **Implement `loadKmlRoute()`** - KML parsing and rendering
5. **Create sample routes** - Add example KML/GPX files for testing

### Feature Roadmap (from README)

| Status | Feature                                          | Added      | Completed  |
| ------ | ------------------------------------------------ | ---------- | ---------- |
| ☑️     | Direction indicators on routes (chevrons/arrows) | 2024-07-05 | 2025-07-11 |
| ⬜     | Email route files (mailto links)                 | 2025-07-09 | -          |
| ⬜     | Social sharing / embed code generation           | 2025-07-10 | -          |
| ⬜     | Club/group logo customization                    | 2025-07-10 | -          |
| ⬜     | Multi-page navigation banner                     | 2025-07-10 | -          |

### Technical Debt

1. **Fix .gitignore conflicts** - CSS and package-lock.json tracked despite ignore rules
2. **Create build.sh script** - Auto-generate routes.json from data directory
3. **Add error handling** - Server-side validation for missing files
4. **Add tests** - Unit tests for route parsing, integration tests for map rendering
5. **Documentation** - JSDoc comments in main.js
6. **Accessibility** - ARIA labels for map controls and buttons

### Refactoring Opportunities

1. **Modularize JavaScript** - Split main.js into separate modules
2. **TypeScript migration** - Add type safety
3. **Build process** - Add webpack/vite for bundling
4. **API abstraction** - Create service layer for Google Maps API
5. **State management** - Implement simple state machine for UI

---

## QUICK REFERENCE

### File Locations

| Purpose           | Path                                |
| ----------------- | ----------------------------------- |
| API Key           | `.env` (line 1)                     |
| Server Config     | `server.js`                         |
| PM2 Config        | `ecosystem.config.js`               |
| Styles (source)   | `style/main.scss`                   |
| Styles (compiled) | `style/main.min.css`                |
| Icons             | `img/icons/*.svg`                   |
| Background        | `img/crater-lake.jpg`               |
| Landing Page      | `index.html`                        |
| Demo Template     | `demo/index.html` (not yet created) |
| Route Data        | `data/*.kml` (not yet created)      |
| Main JavaScript   | `js/main.js` (not yet created)      |

### Commands

```bash
# Development
npm run dev                    # Start dev server (port 6686)

# Production
npm start                      # Start production server
pm2 start ecosystem.config.js  # Start with PM2
pm2 restart moto-rooter        # Restart PM2 process
pm2 logs moto-rooter           # View logs
pm2 status                     # Check status

# Debugging
lsof -i :6686                  # Check port usage
curl http://localhost:6686     # Test server
```

### Important URLs

- **Live Demo:** https://moto-rooter.feralcreative.dev/demo/
- **Repository:** https://github.com/feralcreative/moto-rooter
- **Figma Icons:** https://www.figma.com/design/pFQck3CUIa5twKqMu1IxD5/moto-router

---

## SUCCESS CRITERIA FOR AI AGENTS

An AI agent should be able to:

1. ✅ Understand the project structure and purpose
2. ✅ Locate all configuration files and credentials
3. ✅ Start the development server
4. ✅ Understand the planned architecture (even if not implemented)
5. ✅ Add new routes by creating KML files and updating routes.json
6. ✅ Modify styles by editing SCSS (not CSS directly)
7. ✅ Deploy to production using PM2
8. ✅ Debug common issues using logs and health checks
9. ✅ Extend functionality by adding new waypoint types
10. ✅ Understand security implications (API key management)

**Time to Productivity:** < 5 minutes after reading this document

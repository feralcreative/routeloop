// Express server with Nunjucks for env-injected HTML
require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const nunjucks = require("nunjucks");

const app = express();
const PORT = process.env.PORT || 3000;

// Configure Nunjucks for rendering from project root
const nunjucksEnv = nunjucks.configure(__dirname, {
  autoescape: true,
  express: app,
  noCache: true, // Disable template caching for development
});

// Force Nunjucks to recognize .html files as templates
app.engine("html", nunjucksEnv.render.bind(nunjucksEnv));
app.set("view engine", "html");

// Serve specific static files (but not HTML files which need processing)
app.use("/js", express.static(path.join(__dirname, "js")));
app.use("/style", express.static(path.join(__dirname, "style")));
app.use("/img", express.static(path.join(__dirname, "img")));
app.use("/data", express.static(path.join(__dirname, "demo/data")));
app.use("/favicon.ico", express.static(path.join(__dirname, "favicon.ico")));

// Test route for Nunjucks template rendering
app.get("/test", (req, res) => {
  res.render(
    "test-template.html",
    {
      GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || "",
    },
    (err, html) => {
      if (err) {
        console.error("Error rendering test template:", err);
        return res.status(500).send("Template rendering error");
      }
      res.send(html);
    }
  );
});

// Dynamic route for handling HTML files with direct file reading and string replacement
app.get("/*", (req, res, next) => {
  // Ignore Chrome DevTools requests
  if (req.path.includes(".well-known/appspecific/com.chrome.devtools")) {
    return next();
  }

  // Check if it's an HTML request or a directory request
  if (req.path.endsWith(".html") || req.path.endsWith("/") || (!req.path.includes(".") && req.path !== "/")) {
    let template = req.path.startsWith("/") ? req.path.slice(1) : req.path;

    // Handle directory requests by appending index.html
    if (req.path.endsWith("/") || !req.path.includes(".")) {
      template = template.endsWith("/") ? `${template}index.html` : `${template}/index.html`;
    }

    // Read the file directly
    const filePath = path.join(__dirname, template);

    fs.readFile(filePath, "utf8", (err, content) => {
      if (err) {
        console.error(`Error reading template ${template}:`, err);
        return next(err);
      }

      const apiKey = process.env.GOOGLE_MAPS_API_KEY || "";

      // Replace all instances of {{ GOOGLE_MAPS_API_KEY }} with the actual API key
      let processedContent = content.replace(/\{\{\s*GOOGLE_MAPS_API_KEY\s*\}\}/g, apiKey);

      // Set content type to HTML
      res.setHeader("Content-Type", "text/html");
      res.send(processedContent);
    });
  } else {
    next();
  }
});

// Static files fallback (must come after dynamic HTML routes)
// This serves all remaining files that weren't handled by specific routes above
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

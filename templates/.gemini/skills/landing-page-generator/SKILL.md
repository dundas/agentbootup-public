# Landing Page Generator

Generate production-ready landing pages using Swiss Precision design system, optimized for SEO, deployed to Cloudflare Pages, with analytics integrated.

## What This Does

Quickly create professional marketing sites for Derivative portfolio companies with:

- **Swiss Precision Design** - Minimalist, sharp, functional aesthetic
- **SEO Optimized** - Meta tags, schema.org, sitemap, robots.txt
- **Performance** - Lighthouse 95+, Core Web Vitals green
- **Analytics** - Cloudflare Analytics or Plausible integrated
- **Cloudflare Deploy** - One-command deployment
- **Responsive** - Mobile-first, works on all devices
- **Accessible** - WCAG 2.1 AA compliant

## Usage

```bash
# Generate landing page for new company
/landing-page-generator create "Company Name" --tagline "One-line description"

# Generate Derivative holding company home
/landing-page-generator create "Derivative" --type portfolio

# Update existing landing page
/landing-page-generator update decisive --section hero

# Add pricing section
/landing-page-generator add decisive --section pricing

# Deploy to Cloudflare Pages
/landing-page-generator deploy decisive
```

## Page Types

### 1. Product Landing Page (SaaS)
**Sections:**
- Hero (headline, subheadline, CTA)
- Problem/Solution
- Features (3-6 key features)
- How It Works (3-4 steps)
- Pricing
- Social Proof (testimonials, logos)
- FAQ
- CTA (final call-to-action)

### 2. Portfolio Home (Holding Company)
**Sections:**
- Hero (company overview)
- Portfolio Companies (grid/list)
- Investment Philosophy
- Team/Leadership
- Contact

### 3. Coming Soon
**Sections:**
- Hero (what's coming)
- Email signup
- Launch timeline
- Social links

## Swiss Precision Design Principles

```typescript
// Design constraints from design/design-system.json
const swissPrecision = {
  // NO shadows, gradients, or border-radius
  borders: 'sharp corners only',

  // Typography creates hierarchy
  fonts: {
    ui: 'DM Sans',
    data: 'DM Mono',
    weights: [400, 500, 600, 700]
  },

  // Color is semantic only
  colors: {
    red: '#E53935',    // errors/alerts ONLY
    green: '#2E7D32',  // positive/success ONLY
    grays: ['#FAFAFA', '#F5F5F5', '#E0E0E0', '#BDBDBD', '#757575', '#424242', '#212121']
  },

  // Monospace for data
  data: 'font-swiss-mono for amounts, dates, percentages',

  // Minimal, functional
  aesthetic: 'Dieter Rams + Swiss banking'
};
```

## Example Output

### Decisive Landing Page
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Decisive - Financial Admin for Multi-Entity Operations</title>
  <meta name="description" content="Professional financial administration platform for managing multiple business entities with Swiss precision.">

  <!-- Open Graph -->
  <meta property="og:title" content="Decisive">
  <meta property="og:description" content="Financial Admin for Multi-Entity Operations">
  <meta property="og:image" content="/og-image.png">
  <meta property="og:url" content="https://decisive.derivative.io">

  <!-- Schema.org -->
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "name": "Decisive",
    "description": "Financial Admin for Multi-Entity Operations",
    "url": "https://decisive.derivative.io",
    "applicationCategory": "BusinessApplication"
  }
  </script>

  <!-- Styles -->
  <link rel="stylesheet" href="/styles.css">

  <!-- Fonts -->
  <link rel="preload" href="/fonts/DMSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/DMMono-Regular.woff2" as="font" type="font/woff2" crossorigin>
</head>
<body>
  <!-- Hero -->
  <section class="hero">
    <div class="container">
      <h1>Financial Admin for Multi-Entity Operations</h1>
      <p class="subheadline">Professional financial administration platform for managing multiple business entities with Swiss precision.</p>
      <div class="cta-group">
        <a href="/signup" class="btn-primary">Start Free Trial</a>
        <a href="/demo" class="btn-secondary">Watch Demo</a>
      </div>
    </div>
  </section>

  <!-- Features -->
  <section class="features">
    <div class="container">
      <h2>Built for Precision</h2>
      <div class="feature-grid">
        <div class="feature">
          <h3>Multi-Entity Management</h3>
          <p>Track financials across all your business entities in one unified dashboard.</p>
        </div>
        <div class="feature">
          <h3>Automated Reconciliation</h3>
          <p>Bank feeds sync automatically. Categorize once, never again.</p>
        </div>
        <div class="feature">
          <h3>Real-Time Reporting</h3>
          <p>P&L, balance sheet, cash flow - always current, always accurate.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <section class="cta-final">
    <div class="container">
      <h2>Ready for precision?</h2>
      <a href="/signup" class="btn-primary">Start Free Trial</a>
    </div>
  </section>

  <!-- Footer -->
  <footer>
    <div class="container">
      <p>© 2026 Decisive. Part of <a href="https://derivative.io">Derivative</a>.</p>
      <nav>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="/support">Support</a>
      </nav>
    </div>
  </footer>

  <!-- Analytics -->
  <script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "YOUR_TOKEN"}'></script>
</body>
</html>
```

### CSS (Swiss Precision)
```css
/* Swiss Precision - No shadows, no rounded corners, no gradients */

:root {
  --font-ui: 'DM Sans', system-ui, sans-serif;
  --font-mono: 'DM Mono', monospace;

  --color-bg: #FAFAFA;
  --color-surface: #FFFFFF;
  --color-border: #E0E0E0;
  --color-text: #212121;
  --color-text-secondary: #757575;

  --spacing-unit: 8px;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: var(--font-ui);
  color: var(--color-text);
  background: var(--color-bg);
  line-height: 1.6;
}

/* Sharp, minimal buttons - NO rounded corners */
.btn-primary {
  display: inline-block;
  padding: 16px 32px;
  background: var(--color-text);
  color: var(--color-bg);
  font-weight: 600;
  text-decoration: none;
  border: 1px solid var(--color-text);
  transition: all 150ms ease;
}

.btn-primary:hover {
  background: var(--color-bg);
  color: var(--color-text);
}

.btn-secondary {
  display: inline-block;
  padding: 16px 32px;
  background: transparent;
  color: var(--color-text);
  font-weight: 600;
  text-decoration: none;
  border: 1px solid var(--color-border);
  transition: all 150ms ease;
}

.btn-secondary:hover {
  border-color: var(--color-text);
}

/* Typography hierarchy through weight, not color */
h1 {
  font-size: 48px;
  font-weight: 700;
  line-height: 1.1;
  margin-bottom: 16px;
}

h2 {
  font-size: 32px;
  font-weight: 600;
  line-height: 1.2;
  margin-bottom: 16px;
}

h3 {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 8px;
}

p {
  font-size: 16px;
  font-weight: 400;
  color: var(--color-text-secondary);
}

/* Layout */
.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 24px;
}

section {
  padding: 96px 0;
  border-top: 1px solid var(--color-border);
}

.hero {
  padding: 128px 0;
  text-align: center;
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 48px;
  margin-top: 48px;
}

/* NO shadows, NO rounded corners - pure precision */
```

## File Structure

```
landing-page/
├── index.html
├── styles.css
├── fonts/
│   ├── DMSans-Regular.woff2
│   ├── DMSans-Medium.woff2
│   ├── DMSans-SemiBold.woff2
│   └── DMMono-Regular.woff2
├── images/
│   ├── og-image.png
│   └── logo.svg
├── sitemap.xml
├── robots.txt
├── _headers (Cloudflare)
└── _redirects (Cloudflare)
```

## SEO Checklist

```markdown
- [ ] Title tag (< 60 characters)
- [ ] Meta description (< 160 characters)
- [ ] Open Graph tags (og:title, og:description, og:image, og:url)
- [ ] Twitter Card tags
- [ ] Schema.org markup (SoftwareApplication or Organization)
- [ ] Canonical URL
- [ ] Sitemap.xml
- [ ] Robots.txt
- [ ] Alt text on all images
- [ ] Semantic HTML (h1, h2, header, nav, main, footer)
- [ ] Mobile-responsive (viewport meta tag)
- [ ] Fast loading (< 2s)
- [ ] HTTPS
- [ ] Structured data validation (schema.org validator)
```

## Performance Checklist

```markdown
- [ ] Minified CSS/JS
- [ ] Optimized images (WebP, proper sizes)
- [ ] Fonts preloaded (woff2)
- [ ] Critical CSS inline
- [ ] Defer non-critical JS
- [ ] Lazy load images below fold
- [ ] CDN delivery (Cloudflare)
- [ ] Gzip/Brotli compression
- [ ] Cache headers set
- [ ] Lighthouse score 95+
- [ ] Core Web Vitals green
```

## Cloudflare Deployment

### _headers
```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=()
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none';

/fonts/*
  Cache-Control: public, max-age=31536000, immutable

/images/*
  Cache-Control: public, max-age=31536000, immutable
```

### _redirects
```
# Redirect www to non-www
https://www.decisive.derivative.io/* https://decisive.derivative.io/:splat 301!

# Redirect HTTP to HTTPS
http://decisive.derivative.io/* https://decisive.derivative.io/:splat 301!
```

### Deploy Command
```bash
# Using Wrangler CLI
bun run wrangler pages deploy ./landing-page --project-name decisive-landing

# Or using git integration (recommended)
git push origin main  # Auto-deploys via Cloudflare Pages
```

## Analytics Integration

### Cloudflare Analytics (Recommended)
```html
<!-- Automatic, privacy-friendly, no cookie consent needed -->
<script defer src='https://static.cloudflareinsights.com/beacon.min.js'
        data-cf-beacon='{"token": "YOUR_CLOUDFLARE_TOKEN"}'></script>
```

### Plausible (Alternative)
```html
<!-- Privacy-friendly, GDPR compliant -->
<script defer data-domain="decisive.derivative.io"
        src="https://plausible.io/js/script.js"></script>
```

## Content Templates

### Product Landing Page
```typescript
interface ProductLandingPage {
  hero: {
    headline: string;          // "Financial Admin for Multi-Entity Operations"
    subheadline: string;       // Explain value in 1-2 sentences
    ctaPrimary: string;        // "Start Free Trial"
    ctaSecondary?: string;     // "Watch Demo"
  };

  problem?: {
    headline: string;          // "Managing multiple entities is complex"
    points: string[];          // 3-4 pain points
  };

  solution: {
    headline: string;          // "Built for Precision"
    points: string[];          // 3-4 key benefits
  };

  features: Array<{
    title: string;
    description: string;
    icon?: string;
  }>;

  howItWorks?: Array<{
    step: number;
    title: string;
    description: string;
  }>;

  pricing?: Array<{
    name: string;
    price: string;
    features: string[];
    cta: string;
  }>;

  socialProof?: {
    testimonials: Array<{
      quote: string;
      author: string;
      role: string;
      company?: string;
    }>;
    logos?: string[];
  };

  faq?: Array<{
    question: string;
    answer: string;
  }>;

  finalCTA: {
    headline: string;
    cta: string;
  };
}
```

### Portfolio Home Page
```typescript
interface PortfolioHomePage {
  hero: {
    name: string;              // "Derivative"
    tagline: string;           // "AI-Powered Business Portfolio"
    description: string;       // 2-3 sentence overview
  };

  philosophy: {
    headline: string;          // "Built to Last"
    principles: string[];      // Berkshire-inspired principles
  };

  portfolio: Array<{
    name: string;
    tagline: string;
    domain: string;
    status: string;            // "Live", "Beta", "Coming Soon"
    logo?: string;
  }>;

  team?: Array<{
    name: string;
    role: string;
    bio: string;
  }>;

  contact: {
    email: string;
    social?: Record<string, string>;
  };
}
```

## Commands

```bash
# Create new landing page
/landing-page-generator create <company-name> [options]
  --type product|portfolio|coming-soon
  --tagline "One-line description"
  --domain example.com

# Update section
/landing-page-generator update <company> --section <hero|features|pricing|faq>

# Add section
/landing-page-generator add <company> --section <testimonials|pricing|team>

# Generate from template
/landing-page-generator template <product|portfolio|coming-soon> --company <name>

# Preview locally
/landing-page-generator preview <company>

# Deploy to Cloudflare
/landing-page-generator deploy <company> [--production]

# SEO audit
/landing-page-generator audit <company> --seo

# Performance test
/landing-page-generator audit <company> --performance
```

## Integration with Portfolio

```typescript
// Add landing page to portfolio company
await updateCompany('decisive', {
  urls: {
    landing: 'https://decisive.derivative.io',
    app: 'https://app.decisive.derivative.io'
  }
});
```

## Keywords for Discovery

landing page, marketing site, product page, homepage, SaaS landing page, portfolio site, website generator, page builder, Swiss design, minimalist design, Cloudflare Pages, static site, marketing page, company website, product marketing, SEO landing page

---

**Design Philosophy:** Minimize to maximize. Every pixel serves a purpose. Sharp corners. Clear hierarchy. Swiss Precision.

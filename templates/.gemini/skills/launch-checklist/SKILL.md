# Launch Checklist

Comprehensive pre-launch validation ensuring companies are production-ready before deployment. Systematic checks across security, performance, monitoring, compliance, and operational readiness.

## What This Does

Validates that a portfolio company is ready for production launch by checking:

- **Security** - Auth, secrets, HTTPS, CORS, input validation
- **Performance** - Load testing, caching, bundle size, database optimization
- **Monitoring** - Uptime, errors, analytics, logging
- **Compliance** - Privacy policy, terms, GDPR, accessibility
- **Operations** - Backups, rollback plan, runbook, incident response
- **Business** - Landing page, pricing, support, onboarding
- **Technical** - Tests passing, build succeeds, environment variables set

## Usage

```bash
# Run full launch checklist
/launch-checklist decisive

# Run specific category
/launch-checklist decisive --category security
/launch-checklist decisive --category performance

# Generate checklist markdown
/launch-checklist decisive --output checklist.md

# Check production environment
/launch-checklist decisive --env production

# Continuous validation
/launch-checklist decisive --watch
```

## Checklist Categories

### 1. Security ✓

```markdown
## Security Checklist

### Authentication & Authorization
- [ ] Authentication implemented (ClearAuth, session-based)
- [ ] CSRF protection enabled
- [ ] Session management secure (httpOnly, secure, sameSite)
- [ ] Password requirements enforced (min length, complexity)
- [ ] Rate limiting on auth endpoints
- [ ] Account lockout after failed attempts
- [ ] Logout functionality works
- [ ] Session timeout configured

### Secrets Management
- [ ] No hardcoded secrets in code
- [ ] Environment variables for all secrets
- [ ] .env.example provided (no real values)
- [ ] Secrets not committed to git (.env in .gitignore)
- [ ] Production secrets in Cloudflare environment
- [ ] API keys rotated regularly
- [ ] Database credentials secure

### HTTPS & Network
- [ ] HTTPS enforced (no HTTP)
- [ ] SSL/TLS certificate valid
- [ ] HSTS header set
- [ ] Secure cookies (secure flag)
- [ ] CORS configured properly
- [ ] CSP (Content Security Policy) headers
- [ ] No mixed content warnings

### Input Validation
- [ ] All user inputs validated
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (input sanitization, CSP)
- [ ] File upload validation (type, size, malware scan)
- [ ] API input validation (schema validation)
- [ ] Error messages don't leak info

### Dependencies
- [ ] No known vulnerabilities (`bun audit`)
- [ ] Dependencies up to date
- [ ] Lockfile committed (bun.lockb)
- [ ] Prod dependencies minimal
- [ ] No dev dependencies in production

### Access Control
- [ ] Principle of least privilege
- [ ] Role-based access control (if applicable)
- [ ] Admin panel secured
- [ ] Database access restricted
- [ ] API endpoints auth-protected
- [ ] Sensitive data encrypted at rest
```

### 2. Performance ✓

```markdown
## Performance Checklist

### Frontend
- [ ] Bundle size < 250KB gzipped
- [ ] Code splitting implemented
- [ ] Lazy loading for routes
- [ ] Images optimized (WebP, proper sizes)
- [ ] Fonts optimized (woff2, preload)
- [ ] CSS minified
- [ ] JS minified
- [ ] Tree shaking enabled
- [ ] No console.logs in production

### Caching
- [ ] Static assets cached (long cache headers)
- [ ] API responses cached (where appropriate)
- [ ] CDN configured (Cloudflare)
- [ ] Service worker (if PWA)
- [ ] Browser caching headers set

### Database
- [ ] Indexes on frequently queried columns
- [ ] N+1 queries eliminated
- [ ] Query performance tested
- [ ] Connection pooling configured
- [ ] Slow query logging enabled

### Load Testing
- [ ] Tested with expected traffic (2x peak)
- [ ] Response times < 200ms (p95)
- [ ] No memory leaks
- [ ] Graceful degradation under load
- [ ] Database can handle load

### Monitoring
- [ ] Lighthouse score > 90
- [ ] Core Web Vitals green
- [ ] No render-blocking resources
- [ ] Time to Interactive < 3s
- [ ] First Contentful Paint < 1s
```

### 3. Monitoring & Observability ✓

```markdown
## Monitoring Checklist

### Uptime Monitoring
- [ ] Uptime monitor configured (pingdom, UptimeRobot, etc.)
- [ ] Health check endpoint (/health or /api/health)
- [ ] Health check tests critical paths
- [ ] Alerts configured (email, SMS, Slack)
- [ ] Status page (optional but recommended)

### Error Tracking
- [ ] Error tracking service (Sentry, Rollbar, etc.)
- [ ] Frontend errors captured
- [ ] Backend errors captured
- [ ] Sourcemaps uploaded (for stack traces)
- [ ] Error alerts configured
- [ ] Error rate dashboard

### Analytics
- [ ] Analytics configured (Cloudflare Analytics, Plausible, etc.)
- [ ] Privacy-friendly (GDPR compliant)
- [ ] Key events tracked (signup, purchase, etc.)
- [ ] Funnels defined
- [ ] Conversion tracking
- [ ] User journey analysis

### Logging
- [ ] Structured logging (JSON)
- [ ] Log levels configured (info, warn, error)
- [ ] Sensitive data not logged (passwords, tokens)
- [ ] Logs aggregated (Cloudflare Logs, LogFlare, etc.)
- [ ] Log retention policy defined
- [ ] Searchable logs

### Performance Monitoring
- [ ] Response time tracking
- [ ] Database query performance
- [ ] Memory usage monitored
- [ ] CPU usage monitored
- [ ] Disk usage monitored
```

### 4. Compliance & Legal ✓

```markdown
## Compliance Checklist

### Privacy & Data Protection
- [ ] Privacy policy published
- [ ] Cookie consent (if using cookies)
- [ ] GDPR compliant (if EU users)
- [ ] Data export functionality
- [ ] Data deletion functionality
- [ ] User data encrypted
- [ ] PII handling documented

### Terms & Agreements
- [ ] Terms of service published
- [ ] Terms acceptance tracked
- [ ] Refund policy (if applicable)
- [ ] SLA defined (if applicable)

### Accessibility (WCAG 2.1 Level AA)
- [ ] Semantic HTML
- [ ] Keyboard navigation works
- [ ] Screen reader tested
- [ ] Color contrast sufficient (4.5:1)
- [ ] Alt text on images
- [ ] Form labels present
- [ ] Focus indicators visible
- [ ] No keyboard traps

### Security Disclosures
- [ ] security.txt file
- [ ] Vulnerability disclosure policy
- [ ] Security contact email

### Business
- [ ] Company info (about, contact)
- [ ] Support email/channel
- [ ] Pricing clearly displayed (if paid)
- [ ] Billing system tested (if paid)
```

### 5. Operations ✓

```markdown
## Operations Checklist

### Deployment
- [ ] CI/CD pipeline configured
- [ ] Automated tests run on deploy
- [ ] Zero-downtime deployment
- [ ] Rollback procedure documented
- [ ] Rollback tested
- [ ] Blue-green or canary deployment (if critical)

### Backups
- [ ] Database backups automated
- [ ] Backup frequency defined (daily, hourly)
- [ ] Backup retention policy (30 days)
- [ ] Backup restore tested
- [ ] Backup monitoring/alerts

### Disaster Recovery
- [ ] Incident response plan
- [ ] RTO defined (Recovery Time Objective)
- [ ] RPO defined (Recovery Point Objective)
- [ ] Disaster recovery tested
- [ ] Communication plan for incidents

### Documentation
- [ ] README with setup instructions
- [ ] Architecture diagram
- [ ] API documentation (if applicable)
- [ ] Runbook for common operations
- [ ] Deployment guide
- [ ] Troubleshooting guide

### Team Readiness
- [ ] On-call schedule defined
- [ ] Escalation path clear
- [ ] Contact list updated
- [ ] Team trained on systems
- [ ] Incident response drills conducted
```

### 6. Business & User Experience ✓

```markdown
## Business Checklist

### Landing Page
- [ ] Value proposition clear
- [ ] Call-to-action prominent
- [ ] Social proof (testimonials, logos)
- [ ] Screenshots/demo
- [ ] Pricing visible (if applicable)
- [ ] FAQ section
- [ ] Contact info
- [ ] Mobile responsive

### Onboarding
- [ ] Signup flow tested
- [ ] Welcome email sent
- [ ] Onboarding guide/tutorial
- [ ] Sample data (if applicable)
- [ ] First-run experience polished

### Support
- [ ] Support email configured
- [ ] Support response time defined
- [ ] Help documentation
- [ ] FAQ written
- [ ] Contact form works
- [ ] Support ticketing (if needed)

### Communication
- [ ] Transactional emails work
- [ ] Email templates designed
- [ ] Email deliverability tested
- [ ] Unsubscribe link (if marketing emails)
- [ ] Social media accounts created

### Business Operations
- [ ] Payment processing tested (if paid)
- [ ] Invoicing automated (if paid)
- [ ] Revenue tracking configured
- [ ] User analytics dashboard
- [ ] Growth metrics defined
```

### 7. Technical ✓

```markdown
## Technical Checklist

### Code Quality
- [ ] All tests passing
- [ ] Test coverage > 70%
- [ ] Linting passing (no errors)
- [ ] Type checking passing (if TypeScript)
- [ ] No TODO/FIXME in critical paths
- [ ] Code reviewed

### Build & Deploy
- [ ] Production build succeeds
- [ ] Build reproducible
- [ ] Environment variables documented
- [ ] Production environment configured
- [ ] Domain DNS configured
- [ ] CDN configured

### Database
- [ ] Migrations run successfully
- [ ] Seed data (if needed)
- [ ] Database indexes created
- [ ] Database backups enabled
- [ ] Connection string secure

### Third-Party Services
- [ ] All API keys configured
- [ ] Service quotas checked
- [ ] Webhook endpoints secured
- [ ] External dependencies documented
- [ ] Fallback for service failures

### Version Control
- [ ] Latest code on main branch
- [ ] Version tagged
- [ ] CHANGELOG updated
- [ ] Release notes written
```

## Output Format

### Console Output
```
LAUNCH CHECKLIST - Decisive
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECURITY ✓ 8/8 passed
PERFORMANCE ✓ 12/12 passed
MONITORING ⚠ 10/12 passed
  ✗ Status page not configured
  ✗ Error rate dashboard missing
COMPLIANCE ✓ 15/15 passed
OPERATIONS ⚠ 8/10 passed
  ✗ Disaster recovery not tested
  ✗ Incident response drills not conducted
BUSINESS ✓ 14/14 passed
TECHNICAL ✓ 11/11 passed

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OVERALL: 78/82 (95%) ████████████████████░

CRITICAL ISSUES: 0
WARNINGS: 4

⚠ Recommendation: Address monitoring and operations warnings before launch

READY FOR PRODUCTION: YES (with caveats)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Markdown Output (checklist.md)
```markdown
# Launch Checklist - Decisive
Generated: 2026-02-03

## Summary
- **Overall Progress:** 78/82 (95%)
- **Critical Issues:** 0
- **Warnings:** 4
- **Production Ready:** YES (with caveats)

## Security ✅ 8/8
- [x] Authentication implemented
- [x] CSRF protection enabled
- [x] No hardcoded secrets
...

## Monitoring ⚠️ 10/12
- [x] Uptime monitor configured
- [x] Health check endpoint
- [ ] Status page not configured
- [ ] Error rate dashboard missing
...

## Next Steps
1. Configure status page (statuspage.io or custom)
2. Set up error rate dashboard in monitoring tool
3. Document disaster recovery testing
4. Schedule incident response drill
```

## Automated Checks

```typescript
// Example: Check for hardcoded secrets
async function checkSecrets(codebase: string): Promise<boolean> {
  const secretPatterns = [
    /MECH_API_KEY\s*=\s*["'][^"']+["']/,
    /password\s*=\s*["'][^"']+["']/,
    /api_key\s*=\s*["'][^"']+["']/,
  ];

  const files = await glob('**/*.{ts,js,tsx,jsx}', { cwd: codebase });

  for (const file of files) {
    const content = await readFile(file);
    for (const pattern of secretPatterns) {
      if (pattern.test(content)) {
        return false; // Found hardcoded secret
      }
    }
  }

  return true; // No hardcoded secrets found
}
```

## Integration with Portfolio Dashboard

```typescript
// Update company health score based on checklist
const checklistResults = await runLaunchChecklist('decisive');
const healthScore = (checklistResults.passed / checklistResults.total) * 100;

await updateCompany('decisive', {
  health: { score: healthScore },
  status: healthScore >= 95 ? 'production' : 'beta'
});
```

## Commands

```bash
# Full checklist
/launch-checklist <company>

# Specific category
/launch-checklist <company> --category <security|performance|monitoring|compliance|operations|business|technical>

# Output to file
/launch-checklist <company> --output <file.md>

# Check specific environment
/launch-checklist <company> --env <production|staging|development>

# Continuous validation (watch mode)
/launch-checklist <company> --watch

# Generate report
/launch-checklist <company> --report

# Fix common issues
/launch-checklist <company> --fix
```

## Pre-Launch Workflow

1. **Run checklist**: `/launch-checklist decisive`
2. **Review results**: Check critical issues and warnings
3. **Fix issues**: Address all critical items
4. **Re-run**: Verify fixes
5. **Document**: Save checklist results
6. **Deploy**: Proceed with launch when 95%+ pass
7. **Monitor**: Use portfolio-dashboard to track post-launch

## Post-Launch Validation

After deployment, run checklist again to verify:
- Production environment configured correctly
- Monitoring catching real issues
- Performance under actual load
- Security measures effective

## Keywords for Discovery

launch checklist, production readiness, pre-launch validation, deployment checklist, go-live checklist, production deployment, security checklist, performance validation, compliance check, operational readiness, pre-flight check, launch validation, deployment readiness, production launch, ship checklist

---

**Critical Rule:** No company launches to production with < 90% checklist completion or any critical security issues.

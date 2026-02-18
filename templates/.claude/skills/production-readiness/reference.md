# Production Readiness Generator - Reference Examples

## Example 1: E-Commerce Checkout Feature

### User Request
```
"do we have a skill that will outline all of the user stories we need to test in production before we go live with the new checkout flow?"
```

### AI Action: Context Gathering

**Step 1: Identify source**
```bash
# Check for existing PRD
ls docs/prds/*checkout*.md
# Found: docs/prds/0005-prd-checkout-flow.md
```

**Step 2: Production environment confirmation**
```
This checklist is for PRODUCTION deployment validation.

Please confirm:
1. Production environment: https://shop.example.com
2. Planned go-live: Next Friday (2026-01-24)
3. Deployment lead: DevOps team
4. Rollback: Revert deployment via CI/CD pipeline

User confirms: ✅
```

**Step 3: Gather production context**
```
User impact: All customers (100% traffic)
Compliance: PCI DSS (payment processing)
SLAs: 99.9% uptime, <2s page load
Monitoring: Datadog + PagerDuty alerts configured
```

### Generated Output

**File:** `docs/testplans/production-readiness-checkout-flow.md`

```markdown
# Production Readiness: Checkout Flow

**Generated:** 2026-01-17
**Target Launch Date:** 2026-01-24
**Responsible Team:** E-Commerce Platform Team
**Production Environment:** https://shop.example.com

---

## Executive Summary

**Feature Overview:** New streamlined checkout flow reduces steps from 5 to 3

**User Impact:** All customers (100% traffic) - affects every purchase

**Go/No-Go Criteria:**
- All critical user stories pass in staging
- Payment processing works for all methods
- No data loss or order corruption
- Performance <2s per page

---

## User Stories & Acceptance Criteria

### Critical Stories (Must Pass for Launch)

#### 1. Complete Purchase with Credit Card
**As a** customer
**I want** to complete my purchase with a credit card
**So that** I can buy products quickly

**Priority:** Critical

**Acceptance Criteria:**
- [ ] Card number validation works (Luhn algorithm)
- [ ] CVV and expiry date required and validated
- [ ] Successful charges create orders in database
- [ ] Failed charges show clear error message
- [ ] PCI compliance: No card data stored in logs
- [ ] 3D Secure flow completes successfully

**Test Steps:**
1. Add items to cart
2. Click "Checkout"
3. Enter valid card: 4242 4242 4242 4242
4. Complete 3D Secure challenge
5. Verify order confirmation email received
6. Verify order appears in "My Orders"

**Dependencies:**
- Stripe payment gateway
- Email service (SendGrid)
- Order management system

**Performance:** <2s from submit to confirmation
**Security:** PCI DSS Level 1 compliant
**Monitoring:** Track payment_success and payment_failure metrics
**Rollback:** Orders can be refunded if issues found

---

#### 2. Handle Payment Failures Gracefully
**As a** customer
**I want** clear error messages when my payment fails
**So that** I know what to do next

**Priority:** Critical

**Acceptance Criteria:**
- [ ] Declined card shows user-friendly message
- [ ] Insufficient funds shows balance error
- [ ] Network timeout shows retry option
- [ ] Cart contents preserved after failure
- [ ] No duplicate charges on retry

**Test Steps:**
1. Use test card 4000 0000 0000 0002 (decline)
2. Verify error: "Your card was declined. Please try another card."
3. Verify cart still has items
4. Switch to valid card
5. Complete purchase successfully

**Dependencies:**
- Payment gateway error codes
- Frontend error handling
- Session persistence

---

### Important Stories (High Priority)

#### 3. Apply Promo Code at Checkout
**As a** customer
**I want** to apply a promo code during checkout
**So that** I can get a discount

**Priority:** Important

**Acceptance Criteria:**
- [ ] Valid codes apply discount correctly
- [ ] Invalid codes show error message
- [ ] Expired codes are rejected
- [ ] Discount calculation is accurate
- [ ] Final price reflects discount

---

### Nice-to-Have Stories (Can Launch Without)

#### 4. Save Card for Future Purchases
**As a** returning customer
**I want** to save my card securely
**So that** checkout is faster next time

**Priority:** Nice-to-have

**Acceptance Criteria:**
- [ ] "Save card" checkbox available
- [ ] Card tokenized via Stripe
- [ ] Saved cards appear on next checkout
- [ ] Can delete saved cards

---

## Production Smoke Tests

Run immediately after deployment to https://shop.example.com

### Core Functionality
- [ ] **Complete purchase with credit card**: Use test card, verify order created
- [ ] **Complete purchase with PayPal**: OAuth flow works, order created
- [ ] **Apply promo code**: Code "WELCOME10" applies 10% discount correctly

### Authentication & Authorization
- [ ] Guest checkout works without login
- [ ] Logged-in users see saved addresses
- [ ] Admin users cannot access customer payment data

### Data Integrity
- [ ] Orders written to production database correctly
- [ ] Inventory decremented after purchase
- [ ] No duplicate orders on page refresh
- [ ] Order history shows correct data

### Integrations
- [ ] **Stripe API**: Charges process successfully
- [ ] **PayPal API**: Redirects and callbacks work
- [ ] **Email service**: Confirmation emails sent within 30s
- [ ] **Shipping API**: Address validation works

### Performance
- [ ] Checkout page loads < 1.5s
- [ ] Payment submission < 2s
- [ ] No memory leaks during load test (1000 concurrent)

### Monitoring & Alerting
- [ ] Metrics flowing to Datadog: checkout_started, payment_success, payment_failure
- [ ] Logs include transaction IDs for debugging
- [ ] PagerDuty alerts fire for payment gateway errors
- [ ] Error rate < 0.5%

---

## Rollback Plan

### Rollback Decision Criteria
- [ ] Payment success rate < 95%
- [ ] Order data corruption detected
- [ ] PCI compliance breach
- [ ] Performance degradation > 50%
- [ ] Critical user story failed in production

### Rollback Steps
1. Execute: `kubectl rollout undo deployment/checkout-service`
2. Verify: Check /health endpoint returns 200
3. Notify: Post in #engineering-alerts Slack channel
4. Validate: Run smoke tests against rolled-back version
5. Communicate: Update status page with incident details

### Post-Rollback Actions
- Create incident report in Notion
- Document what failed and root cause
- Plan fix with timeline
- Schedule re-deployment after fix validated in staging

---

## Sign-Off

- [ ] All 2 critical user stories tested and passed
- [ ] All 1 important user story tested and passed
- [ ] Production smoke tests executed and passed (15/15)
- [ ] Monitoring and alerting verified
- [ ] Rollback plan reviewed and ready
- [ ] Stakeholder approval obtained

**Ready for Production:** ☐ Yes  ☐ No

**Sign-Off By:**
- Product Owner: _________________ Date: _______
- Engineering Lead: _________________ Date: _______
- QA Lead: _________________ Date: _______
- Security Lead: _________________ Date: _______

---

*Production readiness checklist generated by agentbootup production-readiness skill*
```

---

## Example 2: Real-Time Notifications Feature

### User Request
```
"We're launching push notifications next week. What user stories do we need to validate in prod?"
```

### AI discovers no PRD exists

**AI Response:**
```
I don't see a PRD for push notifications. Let me generate user stories based on common notification patterns.

I'll create production readiness for real-time notifications.
```

### Generated Output

**File:** `docs/testplans/production-readiness-push-notifications.md`

```markdown
# Production Readiness: Push Notifications

**Generated:** 2026-01-17
**Target Launch Date:** 2026-01-22
**Production Environment:** https://app.example.com

---

## Executive Summary

**Feature Overview:** Real-time push notifications for user actions and alerts

**User Impact:** Opt-in for all users (estimated 60% adoption)

**Go/No-Go Criteria:**
- Notifications delivered within 10 seconds
- No spam or duplicate notifications
- Users can disable notifications
- Battery usage within acceptable limits

---

## User Stories & Acceptance Criteria

### Critical Stories

#### 1. Receive Push Notification for New Message
**As a** user
**I want** to receive a push notification when someone messages me
**So that** I can respond quickly

**Priority:** Critical

**Acceptance Criteria:**
- [ ] Notification appears within 10 seconds of message sent
- [ ] Notification includes sender name and message preview
- [ ] Tapping notification opens the message thread
- [ ] No notifications sent if app is open and active
- [ ] Works on iOS and Android

**Test Steps:**
1. User A logs in on mobile device
2. User A grants notification permission
3. User B sends message to User A
4. Verify notification appears on User A's device within 10s
5. Tap notification
6. Verify message thread opens correctly

**Dependencies:**
- Firebase Cloud Messaging (FCM)
- Push notification service
- WebSocket connection for real-time events

---

#### 2. Disable Notifications
**As a** user
**I want** to disable push notifications
**So that** I'm not disturbed

**Priority:** Critical

**Acceptance Criteria:**
- [ ] Settings page has notification toggle
- [ ] Disabling stops all push notifications
- [ ] Setting persists across app restarts
- [ ] Re-enabling resumes notifications

---

## Production Smoke Tests

### Core Functionality
- [ ] Send test notification: Delivered within 10s
- [ ] Disable notifications: No further notifications received
- [ ] Re-enable notifications: Notifications resume

### Performance
- [ ] Notification delivery latency p95 < 10s
- [ ] Battery drain < 5% per day with notifications enabled
- [ ] No memory leaks from notification service

### Monitoring
- [ ] Track notification_sent and notification_delivered metrics
- [ ] Alert on delivery failure rate > 5%
- [ ] Log notification payload for debugging

---

## Rollback Plan

### Rollback Decision Criteria
- [ ] Notification delivery rate < 90%
- [ ] Battery drain > 10% per day
- [ ] User complaints > 50 in first hour

### Rollback Steps
1. Disable notification feature flag: `PUSH_NOTIFICATIONS_ENABLED=false`
2. Verify no new notifications sent
3. Post rollback announcement in app

---

*Production readiness checklist generated by agentbootup production-readiness skill*
```

---

## Key Differences from test-plan-generator

| Aspect | production-readiness | test-plan-generator |
|--------|---------------------|---------------------|
| **Purpose** | Pre-launch validation | E2E feature testing |
| **Focus** | User stories & acceptance criteria | User journey & workflows |
| **Output** | Go/no-go checklist | Detailed test steps |
| **Audience** | Product owners, stakeholders | QA engineers, developers |
| **When to use** | Before production launch | During development |
| **Includes** | Sign-off section, rollback plan | Issue tracking, fix loop |

---

## Tips for Effective Production Readiness

1. **Prioritize ruthlessly** - Mark only truly blocking items as "Critical"
2. **Be specific** - "Payment works" is too vague; "Stripe charges process successfully for Visa/MC/Amex" is better
3. **Include rollback** - Always have a plan to undo if issues found
4. **Get sign-offs** - Product, engineering, and QA should all approve
5. **Focus on user impact** - What will customers experience if this fails?
6. **Test in production-like environment first** - Staging should mirror production
7. **Have monitoring ready** - Know how you'll detect issues after launch

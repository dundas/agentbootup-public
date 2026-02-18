# User Story Generator - Reference Examples

## Example 1: Social Media Share Feature

### User Request
```
"I need user stories for adding social media sharing to blog posts"
```

### AI Action: Context Gathering

**Questions asked:**
```
I'll help generate user stories for social media sharing on blog posts.

Quick questions:
1. Who is the primary user? → Blog readers and authors
2. What is the main goal? → Increase blog reach via social sharing
3. Different user types? → Authors (want analytics), readers (want to share)
4. Edge cases? → Private posts, broken share links
5. Existing acceptance criteria? → Must support Twitter, LinkedIn, Facebook
```

**User answers:**
```
1. Blog readers (primary), authors (secondary)
2. Increase traffic and engagement
3. Yes - readers share, authors track shares
4. Private posts shouldn't be shareable, handle network errors
5. Must work on Twitter, LinkedIn, Facebook
```

### Generated Output

**File:** `docs/stories/social-media-share-stories.md`

```markdown
# User Stories: Social Media Sharing for Blog Posts

**Generated:** 2026-01-17
**Feature Owner:** Content Platform Team
**Status:** Draft

---

## Overview

**Feature:** Add social media sharing buttons to blog posts
**User Impact:** Blog readers can share content, authors can track shares
**Goal:** Increase blog reach and engagement through social media

---

## User Stories

### 1. Share Blog Post to Twitter

**As a** blog reader
**I want** to share a blog post to Twitter with one click
**So that** my followers can discover great content

**Priority:** High

**Acceptance Criteria:**
- [ ] Share button visible on every published blog post
- [ ] Clicking Twitter button opens Twitter share dialog
- [ ] Pre-populated tweet includes post title and URL
- [ ] Post URL is shortened for Twitter character limits
- [ ] Share works on mobile and desktop
- [ ] Share counts updated in real-time (if user is logged in)

**Out of Scope:**
- Customizing share message (uses default title)
- Sharing draft/unpublished posts

**Dependencies:**
- Twitter API integration
- URL shortener service

**Notes:**
- Use Twitter Web Intent API (no OAuth needed for basic sharing)
- Track share events for analytics

---

### 2. Share Blog Post to LinkedIn

**As a** blog reader
**I want** to share a blog post to LinkedIn
**So that** my professional network can read it

**Priority:** High

**Acceptance Criteria:**
- [ ] LinkedIn share button visible on every published post
- [ ] Clicking opens LinkedIn share dialog
- [ ] Pre-populated with post title, description, and URL
- [ ] Post thumbnail image appears in LinkedIn preview
- [ ] Share works on mobile and desktop

**Out of Scope:**
- LinkedIn profile integration
- Auto-posting to LinkedIn pages

**Dependencies:**
- LinkedIn Share Plugin
- Open Graph meta tags for rich previews

**Notes:**
- Ensure og:image, og:title, og:description tags are present
- Image should be at least 1200x627px for LinkedIn

---

### 3. Share Blog Post to Facebook

**As a** blog reader
**I want** to share a blog post to Facebook
**So that** my friends and family can read it

**Priority:** High

**Acceptance Criteria:**
- [ ] Facebook share button visible on every published post
- [ ] Clicking opens Facebook share dialog
- [ ] Pre-populated with post title, description, and URL
- [ ] Post thumbnail image appears in Facebook preview
- [ ] Share works on mobile and desktop

**Out of Scope:**
- Facebook page integration
- Auto-posting to Facebook groups

**Dependencies:**
- Facebook Share Dialog API
- Open Graph meta tags

**Notes:**
- Use Facebook SDK or Share Dialog URL
- Test with Facebook Sharing Debugger

---

### 4. Handle Share Errors Gracefully

**As a** blog reader
**I want** clear error messages if sharing fails
**So that** I know what went wrong

**Priority:** Medium

**Acceptance Criteria:**
- [ ] Network timeout shows "Could not connect. Please try again."
- [ ] Popup blocked shows "Please allow popups to share"
- [ ] API errors show generic "Sharing failed" message (don't expose technical details)
- [ ] Failed share doesn't break page functionality
- [ ] User can retry after error

**Out of Scope:**
- Detailed error logging visible to users

**Dependencies:**
- Error handling middleware
- Frontend error boundary

**Notes:**
- Log errors to analytics for debugging
- Don't expose API keys or technical details to users

---

### 5. Prevent Sharing Private Posts

**As a** blog author
**I want** private/draft posts to not be shareable
**So that** unpublished content doesn't leak

**Priority:** High

**Acceptance Criteria:**
- [ ] Share buttons hidden on draft posts
- [ ] Share buttons hidden on private posts
- [ ] Share buttons hidden on scheduled posts (not yet published)
- [ ] Direct share URL attempts return 404 or "Post not found"
- [ ] Share button appears automatically when post is published

**Out of Scope:**
- Preview links for draft posts (different feature)

**Dependencies:**
- Post status logic (published vs draft vs private)

**Notes:**
- Critical for security - verify post status server-side
- Don't trust client-side checks alone

---

### 6. View Share Analytics (Author View)

**As a** blog author
**I want** to see how many times my post was shared
**So that** I can measure engagement

**Priority:** Medium

**Acceptance Criteria:**
- [ ] Author dashboard shows share count per post
- [ ] Breakdown by platform (Twitter, LinkedIn, Facebook)
- [ ] Share count updates within 5 minutes of share event
- [ ] Share count visible in post analytics page

**Out of Scope:**
- Who specifically shared (privacy concern)
- Reshares/retweets tracking

**Dependencies:**
- Analytics backend
- Share event tracking

**Notes:**
- Track share events via backend API, not client-side only
- Consider privacy implications of share tracking

---

### 7. Copy Share Link

**As a** blog reader
**I want** to copy the blog post URL to clipboard
**So that** I can share it manually (email, messaging apps, etc.)

**Priority:** Low

**Acceptance Criteria:**
- [ ] "Copy link" button visible next to social share buttons
- [ ] Clicking copies full post URL to clipboard
- [ ] User sees confirmation: "Link copied!"
- [ ] Works on all browsers that support clipboard API
- [ ] Fallback for browsers without clipboard API (show URL in text field)

**Out of Scope:**
- Shortened URLs for manual sharing

**Dependencies:**
- Browser Clipboard API

**Notes:**
- Use navigator.clipboard.writeText()
- Provide fallback for older browsers (select text field)

---

## Story Summary

| # | Story | User Type | Priority | Dependencies |
|---|-------|-----------|----------|--------------|
| 1 | Share to Twitter | Reader | High | Twitter API, URL shortener |
| 2 | Share to LinkedIn | Reader | High | LinkedIn plugin, OG tags |
| 3 | Share to Facebook | Reader | High | Facebook SDK, OG tags |
| 4 | Handle share errors | Reader | Medium | Error handling |
| 5 | Prevent sharing private posts | Author | High | Post status logic |
| 6 | View share analytics | Author | Medium | Analytics backend |
| 7 | Copy share link | Reader | Low | Clipboard API |

**Total Stories:** 7
**High Priority:** 4 | **Medium:** 2 | **Low:** 1

---

## Next Steps

- [ ] Review stories with product owner
- [ ] Add story point estimates
- [ ] Prioritize for sprint planning
- [ ] Add to backlog
- [ ] Consider creating full PRD if more detail needed

---

*User stories generated by agentbootup user-story-generator skill*
```

---

## Example 2: Password Reset Feature

### User Request
```
"Generate user stories for password reset functionality"
```

### AI discovers common patterns

**AI Response:**
```
I'll generate user stories for password reset. This is a common security-critical feature, so I'll include edge cases and security scenarios.
```

### Generated Output

**File:** `docs/stories/password-reset-stories.md`

```markdown
# User Stories: Password Reset

**Generated:** 2026-01-17
**Feature Owner:** Security Team
**Status:** Ready for Development

---

## Overview

**Feature:** Self-service password reset for users who forgot their password
**User Impact:** Users can regain access to their account without support
**Goal:** Reduce support burden and improve user experience

---

## User Stories

### 1. Request Password Reset

**As a** user who forgot my password
**I want** to request a password reset email
**So that** I can regain access to my account

**Priority:** High

**Acceptance Criteria:**
- [ ] "Forgot password?" link visible on login page
- [ ] Clicking opens password reset form
- [ ] Form accepts email address only
- [ ] Email validation: Must be valid format
- [ ] User receives reset email within 2 minutes
- [ ] Success message shows: "Check your email for reset instructions"
- [ ] No indication if email exists in system (security: prevent email enumeration)

**Out of Scope:**
- SMS-based reset
- Security questions

**Dependencies:**
- Email service (SendGrid/SES)
- Token generation service

**Notes:**
- Always show success message, even if email not found (prevent enumeration)
- Rate limit: Max 3 reset requests per hour per email

---

### 2. Reset Password via Email Link

**As a** user
**I want** to click a link in the email to reset my password
**So that** the process is convenient and secure

**Priority:** High

**Acceptance Criteria:**
- [ ] Email contains unique, single-use reset link
- [ ] Link valid for 1 hour only
- [ ] Clicking link opens password reset page
- [ ] Page shows password input fields (new password, confirm password)
- [ ] Password requirements displayed (min 8 chars, 1 uppercase, 1 number, 1 special)
- [ ] Passwords must match
- [ ] Submitting saves new password
- [ ] Success message: "Password reset successful. Please log in."
- [ ] User redirected to login page

**Out of Scope:**
- Password strength meter (nice to have)

**Dependencies:**
- Token validation service
- Password hashing (bcrypt/argon2)

**Notes:**
- Token should be cryptographically random (use crypto.randomBytes)
- Hash token in database (don't store plaintext)
- Invalidate token after use

---

### 3. Handle Expired Reset Link

**As a** user
**I want** a clear message if my reset link expired
**So that** I know what to do next

**Priority:** Medium

**Acceptance Criteria:**
- [ ] Expired link shows: "This link has expired. Please request a new one."
- [ ] Page includes "Request new reset link" button
- [ ] Clicking button goes to password reset request form
- [ ] Email pre-filled if available from URL

**Out of Scope:**
- Extending token validity

**Dependencies:**
- Token expiration logic

**Notes:**
- Expire tokens after 1 hour for security

---

### 4. Prevent Brute Force Attacks

**As a** system administrator
**I want** rate limiting on password reset requests
**So that** attackers can't abuse the feature

**Priority:** High

**Acceptance Criteria:**
- [ ] Max 3 reset requests per email per hour
- [ ] Max 10 reset requests per IP per hour
- [ ] Exceeding limits shows: "Too many requests. Please try again later."
- [ ] Rate limits reset after 1 hour
- [ ] Suspicious activity logged for monitoring

**Out of Scope:**
- CAPTCHA (separate story if needed)

**Dependencies:**
- Rate limiting middleware (Redis-based)

**Notes:**
- Use sliding window rate limiting
- Log all reset attempts for security monitoring

---

### 5. Notify User of Password Change

**As a** user
**I want** an email notification when my password is changed
**So that** I'm alerted to potential unauthorized access

**Priority:** Medium

**Acceptance Criteria:**
- [ ] Email sent immediately after password reset
- [ ] Email includes: "Your password was changed on [date/time]"
- [ ] Email includes: "If you didn't make this change, contact support immediately"
- [ ] Email sent to the account email address
- [ ] Email includes support contact link

**Out of Scope:**
- SMS notification

**Dependencies:**
- Email service

**Notes:**
- Critical for security - helps users detect account takeover
- Don't include new password in email

---

## Story Summary

| # | Story | User Type | Priority | Dependencies |
|---|-------|-----------|----------|--------------|
| 1 | Request reset | User | High | Email service, tokens |
| 2 | Reset via link | User | High | Token validation, hashing |
| 3 | Handle expired link | User | Medium | Token expiration |
| 4 | Prevent brute force | Admin | High | Rate limiting |
| 5 | Notify of change | User | Medium | Email service |

**Total Stories:** 5
**High Priority:** 3 | **Medium:** 2 | **Low:** 0

---

## Next Steps

- [ ] Review security considerations with security team
- [ ] Add story point estimates
- [ ] Add to sprint backlog
- [ ] Consider penetration testing after implementation

---

*User stories generated by agentbootup user-story-generator skill*
```

---

## Key Differences from prd-writer

| Aspect | user-story-generator | prd-writer |
|--------|---------------------|------------|
| **Output** | Standalone user stories | Full PRD document |
| **Detail** | Stories + criteria only | Stories + goals + design + tech specs |
| **Time** | 5-10 minutes | 30-60 minutes |
| **Use case** | Quick backlog items | Comprehensive feature spec |
| **Audience** | Dev team, product owner | Entire team + stakeholders |
| **When** | Backlog grooming, refinement | Feature planning, kickoff |

---

## Tips for Effective User Stories

1. **Follow the format** - Always "As a [user], I want [action], so that [benefit]"
2. **Be specific** - "User can login" is too vague; "User can login with email and password" is better
3. **Include edge cases** - Don't forget error handling and unhappy paths
4. **Testable criteria** - Each criterion should be verifiable by QA
5. **User-focused** - Describe behavior, not implementation
6. **Independent** - Each story should stand alone
7. **Prioritize ruthlessly** - Not everything is High priority
8. **Consider security** - Always include security-related stories for sensitive features

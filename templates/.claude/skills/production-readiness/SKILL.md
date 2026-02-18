---
name: production-readiness
description: Generate comprehensive pre-launch checklist of user stories, acceptance criteria, and smoke tests to validate before going live in production.
category: quality
---

# Production Readiness Generator

## Goal
Create a comprehensive pre-launch checklist that outlines all user stories, acceptance criteria, and smoke tests that must pass before deploying to production.

## Input Sources
- **PRD File** - Generate from `docs/prds/[n]-prd-*.md`
- **Feature Description** - Generate from verbal description
- **Existing User Stories** - Extract from project documentation

## Output
- **Format:** Markdown (`.md`)
- **Location:** `docs/testplans/`
- **Filename:** `production-readiness-[feature-name].md`

---

## Process

### Phase 1: Context Gathering

1. **Identify Input Source**
   - Check if user provided PRD, feature description, or reference to existing docs
   - If PRD: read and analyze user stories and acceptance criteria
   - If description: extract key functionality
   - If existing: scan docs for user story patterns

2. **GATE: Production Environment Confirmation**
   Ask the user:
   ```
   This checklist is for PRODUCTION deployment validation.

   Please confirm:
   1. What is the current production environment? (URL, platform)
   2. When is the planned go-live date?
   3. Who is responsible for production deployment?
   4. What is the rollback procedure if issues are found?

   Do NOT proceed without explicit confirmation.
   ```

3. **Gather Production Context**
   ```
   Additional production context needed:
   1. What is the user impact of this feature? (all users, subset, opt-in)
   2. Are there any compliance requirements? (GDPR, HIPAA, SOC2, etc.)
   3. What are the SLAs/performance requirements?
   4. What monitoring/alerting is in place?
   ```

### Phase 2: User Story Extraction

4. **Map All User Stories**

   Extract or generate complete set of user stories:

   **From PRD/Documentation:**
   - Scan for "As a [user], I want [action], so that [benefit]" patterns
   - Extract acceptance criteria from requirements sections
   - Identify edge cases and error scenarios

   **Generate if needed:**
   - Primary user flows (happy path)
   - Edge cases and error handling
   - Performance and scale scenarios
   - Security and compliance scenarios
   - Rollback and recovery scenarios

5. **Categorize User Stories**

   Group by:
   - **Critical** - Must work for launch (blocking)
   - **Important** - Should work for launch (high priority)
   - **Nice-to-have** - Can work after launch (non-blocking)

### Phase 3: Generate Acceptance Criteria

6. **Define Acceptance Criteria for Each Story**

   For each user story, create specific, testable criteria:

   ```markdown
   ### User Story: [Title]
   **As a** [user type]
   **I want** [action]
   **So that** [benefit]

   **Priority:** Critical | Important | Nice-to-have

   **Acceptance Criteria:**
   - [ ] [Specific, measurable criterion 1]
   - [ ] [Specific, measurable criterion 2]
   - [ ] [Error handling criterion]
   - [ ] [Performance criterion]

   **Test Steps:**
   1. [Step 1]
   2. [Step 2]
   3. [Expected outcome]

   **Dependencies:**
   - [Service, API, or feature this depends on]
   ```

7. **Add Production-Specific Criteria**

   For each story, add:
   - **Performance:** Response times, load handling
   - **Security:** Authentication, authorization, data protection
   - **Monitoring:** What metrics/logs to check
   - **Rollback:** How to undo if this fails

### Phase 4: Generate Production Smoke Tests

8. **Create Smoke Test Checklist**

   ```markdown
   ## Production Smoke Tests

   Run these tests IMMEDIATELY after deployment:

   ### 1. Core Functionality
   - [ ] [Critical path 1]: [Expected outcome]
   - [ ] [Critical path 2]: [Expected outcome]

   ### 2. Authentication & Authorization
   - [ ] Login works for all user types
   - [ ] Permissions are enforced correctly
   - [ ] Session management working

   ### 3. Data Integrity
   - [ ] Data reads correctly from production DB
   - [ ] Data writes successfully
   - [ ] No data corruption or loss

   ### 4. Integrations
   - [ ] External API calls succeed
   - [ ] Webhook deliveries working
   - [ ] Third-party services responding

   ### 5. Performance
   - [ ] Page load times < [X]ms
   - [ ] API response times < [Y]ms
   - [ ] No memory leaks or resource exhaustion

   ### 6. Monitoring & Alerting
   - [ ] Metrics being collected
   - [ ] Logs flowing correctly
   - [ ] Alerts configured and firing appropriately
   ```

### Phase 5: Generate Rollback Plan

9. **Document Rollback Procedures**

   ```markdown
   ## Rollback Plan

   If critical issues are found during validation:

   ### Rollback Decision Criteria
   - [ ] Critical user story failed
   - [ ] Data integrity compromised
   - [ ] Security vulnerability detected
   - [ ] Performance degradation > [X]%
   - [ ] [Other criterion]

   ### Rollback Steps
   1. [Command or process to rollback deployment]
   2. [Verification step to confirm rollback]
   3. [Communication plan - who to notify]
   4. [Post-rollback validation]

   ### Post-Rollback Actions
   - Document what failed and why
   - Create incident report
   - Plan fix and re-deployment
   ```

### Phase 6: Review & Save

10. **Present Draft to User**
    ```
    I've generated a production readiness checklist with:
    - [N] user stories categorized by priority
    - [N] acceptance criteria across all stories
    - Production smoke tests
    - Rollback plan

    Review for completeness before I save.
    ```

11. **Save Production Readiness Checklist**
    Save to `docs/testplans/production-readiness-[feature-name].md`

12. **Summarize Next Steps**
    ```
    Production readiness checklist created at:
    docs/testplans/production-readiness-[feature-name].md

    Next steps:
    1. Review with product owner and stakeholders
    2. Execute all critical user story tests in staging
    3. Run production smoke tests after deployment
    4. Have rollback plan ready
    5. Monitor production metrics during and after launch
    ```

---

## Output Format Template

```markdown
# Production Readiness: [Feature Name]

**Generated:** YYYY-MM-DD
**Target Launch Date:** YYYY-MM-DD
**Responsible Team:** [Team name]
**Production Environment:** [URL or platform]

---

## Executive Summary

**Feature Overview:** [Brief description]
**User Impact:** [Who is affected and how]
**Go/No-Go Criteria:** [What must pass for launch]

---

## User Stories & Acceptance Criteria

### Critical Stories (Must Pass for Launch)

#### 1. [User Story Title]
**As a** [user type]
**I want** [action]
**So that** [benefit]

**Acceptance Criteria:**
- [ ] [Criterion 1]
- [ ] [Criterion 2]

**Test Steps:**
1. [Step 1]
2. [Expected outcome]

**Dependencies:** [List]

---

### Important Stories (High Priority)

[Repeat format]

---

### Nice-to-Have Stories (Can Launch Without)

[Repeat format]

---

## Production Smoke Tests

Run immediately after deployment:

### Core Functionality
- [ ] [Test 1]
- [ ] [Test 2]

### Authentication & Authorization
- [ ] [Test 1]

### Data Integrity
- [ ] [Test 1]

### Integrations
- [ ] [Test 1]

### Performance
- [ ] [Test 1]

### Monitoring
- [ ] [Test 1]

---

## Rollback Plan

### Rollback Decision Criteria
- [ ] [Criterion 1]

### Rollback Steps
1. [Step 1]

### Post-Rollback Actions
- [Action 1]

---

## Sign-Off

- [ ] All critical user stories tested and passed
- [ ] Production smoke tests executed and passed
- [ ] Monitoring and alerting verified
- [ ] Rollback plan reviewed and ready
- [ ] Stakeholder approval obtained

**Ready for Production:** ☐ Yes  ☐ No

**Sign-Off By:**
- Product Owner: _________________ Date: _______
- Engineering Lead: _________________ Date: _______
- QA Lead: _________________ Date: _______

---

*Production readiness checklist generated by agentbootup*
```

---

## Key Principles

- **Production-Focused:** Every test must be relevant to production validation
- **No Arbitrary Timeframes:** Focus on criteria that must pass, not when testing happens
- **Actionable Checklist:** Every item should be testable and have clear pass/fail
- **Risk-Aware:** Prioritize by criticality and user impact
- **Rollback-Ready:** Always have a plan to undo if issues are found

---

## Integration with Other Skills

- **After prd-writer:** Generate production readiness from PRD
- **Before deployment:** Use as pre-launch checklist
- **With test-plan-generator:** test-plan-generator is for feature E2E testing; production-readiness is for launch validation
- **With runbook-generator:** Reference production smoke tests in operational runbook

---

## Target Audience

- Product owners deciding if feature is ready to launch
- QA teams validating production readiness
- Engineering leads signing off on deployments
- Stakeholders assessing go/no-go decisions

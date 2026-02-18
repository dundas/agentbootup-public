# Rule: Generating a Production Readiness Checklist

## Goal

To guide an AI assistant in creating a comprehensive pre-launch checklist that outlines all user stories, acceptance criteria, and smoke tests that must pass before deploying a feature to production.

## Output

- **Format:** Markdown (`.md`)
- **Location:** `docs/testplans/`
- **Filename:** `production-readiness-[feature-name].md`

## Process

### Phase 1: Context Gathering

1. **Identify Input Source**

   Determine what the user is providing:
   - PRD file path (e.g., `docs/prds/0005-prd-checkout-flow.md`)
   - Feature description (verbal explanation)
   - Reference to existing documentation

   If PRD exists, read and analyze user stories and acceptance criteria.

2. **GATE: Production Environment Confirmation (REQUIRED)**

   Ask the user explicitly:
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

   Ask additional questions:
   ```
   Additional production context needed:
   1. What is the user impact of this feature? (all users, subset, opt-in)
   2. Are there any compliance requirements? (GDPR, HIPAA, SOC2, PCI DSS)
   3. What are the SLAs/performance requirements?
   4. What monitoring/alerting is in place?
   ```

### Phase 2: User Story Extraction

4. **Map All User Stories**

   **If PRD exists:**
   - Scan for "As a [user], I want [action], so that [benefit]" patterns
   - Extract acceptance criteria from requirements sections
   - Identify edge cases and error scenarios from PRD

   **If no PRD (generating from description):**
   - Generate complete set of user stories covering:
     - Primary user flows (happy path)
     - Edge cases and error handling
     - Performance and scale scenarios
     - Security and compliance scenarios
     - Rollback and recovery scenarios

5. **Categorize User Stories**

   Group into three priority levels:
   - **Critical** - Must work for launch (blocking)
   - **Important** - Should work for launch (high priority, but not blocking)
   - **Nice-to-have** - Can work after launch (non-blocking)

   Be ruthless with prioritization. Only truly blocking items should be "Critical".

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
   1. [Concrete step 1]
   2. [Concrete step 2]
   3. [Expected outcome]

   **Dependencies:**
   - [Service, API, or feature this depends on]
   ```

   **Criteria must be:**
   - Specific (not vague like "it works")
   - Measurable (with expected outcomes)
   - Testable (can be verified in production)

7. **Add Production-Specific Criteria**

   For each story, add:
   - **Performance:** Response times, load handling, resource usage
   - **Security:** Authentication, authorization, data protection, compliance
   - **Monitoring:** What metrics/logs to check, alert thresholds
   - **Rollback:** How to undo if this specific story fails

### Phase 4: Generate Production Smoke Tests

8. **Create Smoke Test Checklist**

   Generate quick tests to run IMMEDIATELY after deployment:

   ```markdown
   ## Production Smoke Tests

   Run these tests immediately after deployment:

   ### 1. Core Functionality
   - [ ] [Critical path 1]: [Expected outcome in <10 words]
   - [ ] [Critical path 2]: [Expected outcome]

   ### 2. Authentication & Authorization
   - [ ] Login works for all user types
   - [ ] Permissions are enforced correctly
   - [ ] Session management working

   ### 3. Data Integrity
   - [ ] Data reads correctly from production database
   - [ ] Data writes successfully
   - [ ] No data corruption or loss

   ### 4. Integrations
   - [ ] External API calls succeed (list specific APIs)
   - [ ] Webhook deliveries working
   - [ ] Third-party services responding

   ### 5. Performance
   - [ ] Page load times < [X]ms (specify threshold)
   - [ ] API response times < [Y]ms
   - [ ] No memory leaks or resource exhaustion

   ### 6. Monitoring & Alerting
   - [ ] Metrics being collected (list specific metrics)
   - [ ] Logs flowing correctly
   - [ ] Alerts configured and firing appropriately
   ```

   **Each smoke test must:**
   - Be executable within 5-10 minutes
   - Have clear pass/fail criteria
   - Be production-safe (no destructive operations)

### Phase 5: Generate Rollback Plan

9. **Document Rollback Procedures**

   ```markdown
   ## Rollback Plan

   ### Rollback Decision Criteria
   - [ ] Critical user story failed
   - [ ] Data integrity compromised
   - [ ] Security vulnerability detected
   - [ ] Performance degradation > [X]%
   - [ ] Error rate > [Y]%
   - [ ] [Other project-specific criterion]

   ### Rollback Steps
   1. [Specific command or process to rollback deployment]
   2. [Verification step to confirm rollback succeeded]
   3. [Communication plan - who to notify, what channels]
   4. [Post-rollback validation checklist]

   ### Post-Rollback Actions
   - Document what failed and why (incident report)
   - Create tickets for issues found
   - Plan fix with timeline
   - Schedule re-deployment after fix validated in staging
   ```

   **Rollback plan must include:**
   - Specific commands (not "revert the deployment")
   - Verification steps (how to confirm rollback worked)
   - Communication plan (Slack channels, status page, etc.)

### Phase 6: Review & Save

10. **Present Draft to User**
    ```
    I've generated a production readiness checklist with:
    - [N] user stories ([X] critical, [Y] important, [Z] nice-to-have)
    - [N] acceptance criteria across all stories
    - [N] production smoke tests
    - Rollback plan with [N] decision criteria

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
    2. Execute all critical user story tests in staging environment
    3. Run production smoke tests after deployment
    4. Have rollback plan ready and rehearsed
    5. Monitor production metrics during and after launch
    6. Get sign-offs before proceeding with deployment
    ```

---

## Output Format Template

The generated checklist must include:

```markdown
# Production Readiness: [Feature Name]

**Generated:** YYYY-MM-DD
**Target Launch Date:** YYYY-MM-DD
**Responsible Team:** [Team name]
**Production Environment:** [URL or platform]

---

## Executive Summary

**Feature Overview:** [1-2 sentence description]
**User Impact:** [Who is affected and how]
**Go/No-Go Criteria:** [Top 3-5 things that must pass]

---

## User Stories & Acceptance Criteria

### Critical Stories (Must Pass for Launch)
[List of stories with full acceptance criteria]

### Important Stories (High Priority)
[List of stories]

### Nice-to-Have Stories (Can Launch Without)
[List of stories]

---

## Production Smoke Tests
[Categorized checklist]

---

## Rollback Plan
[Decision criteria, steps, post-rollback actions]

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

1. **Production-Focused:** Every test must be relevant to production validation, not general feature testing
2. **No Arbitrary Timeframes:** Focus on criteria that must pass, not when testing happens
3. **Actionable Checklist:** Every item should be testable and have clear pass/fail
4. **Risk-Aware:** Prioritize by criticality and user impact
5. **Rollback-Ready:** Always have a plan to undo if issues are found
6. **Stakeholder Buy-In:** Include sign-off section for product, engineering, and QA

---

## Differences from test-plan-generator

| Aspect | production-readiness | test-plan-generator |
|--------|---------------------|---------------------|
| **Purpose** | Pre-launch validation checklist | Feature E2E testing guide |
| **Focus** | User stories & acceptance criteria | User journey & workflows |
| **Format** | Go/no-go checklist | Detailed test plan with steps |
| **Audience** | Product owners, stakeholders | QA engineers, developers |
| **When to use** | Before production launch | During feature development |
| **Includes** | Sign-off section, rollback plan | Issue tracking, fix loop |
| **Granularity** | High-level stories | Detailed test cases |

Use **production-readiness** for: "Are we ready to launch?"
Use **test-plan-generator** for: "How do we test this feature thoroughly?"

---

## Target Audience

The production readiness checklist should be usable by:
- **Product owners** deciding if feature is ready to launch
- **Engineering leads** signing off on deployments
- **QA teams** validating production readiness
- **Stakeholders** assessing go/no-go decisions
- **DevOps** planning deployment and monitoring

---

## Integration with Other Skills

- **After prd-writer:** Generate production readiness from PRD user stories
- **Before deployment:** Use as pre-launch validation checklist
- **With test-plan-generator:** test-plan-generator for dev/staging E2E; production-readiness for launch validation
- **With runbook-generator:** Reference production smoke tests in operational runbook
- **With changelog-manager:** Track production launches in changelog

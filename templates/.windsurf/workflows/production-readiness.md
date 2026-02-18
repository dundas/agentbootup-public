# Production Readiness

Generate comprehensive pre-launch checklist with user stories and acceptance criteria.

## Input
- PRD file, feature description, or existing documentation

## Steps

1. **Identify Input Source**
   - Use @skills/production-readiness/SKILL.md
   - Check for PRD in docs/prds/
   - Or generate from feature description

2. **GATE: Production Environment Confirmation**
   - Ask explicitly: production URL, go-live date, deployment owner, rollback procedure
   - Do NOT proceed without confirmation

3. **Gather Production Context**
   - User impact scope
   - Compliance requirements (GDPR, HIPAA, SOC2)
   - SLAs and performance requirements
   - Monitoring and alerting setup

4. **Extract/Generate User Stories**
   - Map all user stories from PRD or description
   - Categorize: Critical, Important, Nice-to-have
   - Include edge cases and error scenarios

5. **Define Acceptance Criteria**
   - Create specific, testable criteria for each story
   - Add production-specific requirements (performance, security, monitoring)
   - Document dependencies

6. **Generate Production Smoke Tests**
   - Core functionality tests
   - Authentication & authorization tests
   - Data integrity tests
   - Integration tests
   - Performance benchmarks
   - Monitoring verification

7. **Document Rollback Plan**
   - Rollback decision criteria
   - Step-by-step rollback procedure
   - Post-rollback validation
   - Communication plan

8. **Present Draft for Review**
   - Show generated checklist to user
   - Confirm completeness

9. **Save to Repository**
   - Save as `docs/testplans/production-readiness-[feature-name].md`
   - Summarize next steps

## Output
`docs/testplans/production-readiness-[feature-name].md`

## Next Actions
- Review with stakeholders
- Execute critical tests in staging
- Prepare for production deployment
- Have rollback plan ready

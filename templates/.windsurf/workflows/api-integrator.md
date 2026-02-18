<!-- AUTO-GENERATED from .claude/skills/api-integrator/SKILL.md -->
# Api Integrator

Learn and integrate new APIs, creating permanent skills for external service access..

## Input
See skill documentation

## Steps

### Step 1: Receive Credentials
When user provides API access:
```
"Here's my [Service] API key: xxx"
```

1. **Acknowledge** receipt (never echo the key)
2. **Store securely** in designated location
3. **Confirm** storage without exposing value

### Step 2: Learn the API

1. **Fetch Documentation**
   - Request docs URL if not provided
   - Read API reference
   - Identify authentication method

2. **Understand Capabilities**
   - List available endpoints
   - Note rate limits
   - Identify common use cases

3. **Map to User Needs**
   - What will the user likely want to do?
   - What are the most valuable operations?

### Step 3: Build Integration

1. **Test Authentication**
   - Make a simple API call
   - Verify credentials work
   - Handle auth errors gracefully

2. **Implement Core Operations**
   - Start with most common use cases
   - Build reusable patterns
   - Add error handling

3. **Validate End-to-End**
   - Test each operation
   - Verify output formats
   - Check edge cases

### Step 4: Create Skill

Save as `skills/<service>-api/SKILL.md`:

```yaml
---
name: service-api
description: Integration with [Service] for [capabilities].
env:
  - SERVICE_API_KEY
---

# [Service] API Integration

## Output
See skill documentation

## Reference

Use @skills/api-integrator/SKILL.md for detailed process documentation.

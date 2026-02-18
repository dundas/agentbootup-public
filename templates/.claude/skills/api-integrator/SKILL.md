---
name: api-integrator
description: Learn and integrate new APIs, creating permanent skills for external service access.
category: autonomous
---

# API Integrator

> **Important: Instruction Template**
> This skill provides instructions for Claude Code to follow when integrating APIs.
> There is no automatic credential encryption - you must implement your own secure
> storage mechanism. Never store credentials in plaintext in files that will be committed.

## Goal
Transform API access credentials into permanent, reusable integration skills.

## When to Use
- User provides a new API key
- Need to connect to an external service
- Building automation that requires API access
- Extending agent capabilities with new tools

## Process

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

## Goal
[What this integration enables]

## Capabilities
- [Capability 1]
- [Capability 2]
- [Capability 3]

## Authentication
- Type: [API Key / OAuth / etc.]
- Header: [Where key goes]

## Operations

### [Operation 1]
**Endpoint:** `GET /endpoint`
**Purpose:** [What it does]
**Example:** [How to use]

### [Operation 2]
...

## Rate Limits
- [Limit details]
- [Retry strategy]

## Error Handling
- [Common errors]
- [How to handle]
```

### Step 5: Announce Integration

```
"I've integrated with [Service]! 🎉

I can now:
• [Capability 1]
• [Capability 2]
• [Capability 3]

This is permanently saved. Try asking me to [example task]."
```

## Integration Templates

### REST API Template
```yaml
---
name: rest-service-api
description: REST API integration template
env:
  - API_KEY
---

# REST Service Integration

## Authentication
```
Headers: {
  "Authorization": "Bearer ${API_KEY}"
}
```

## Base URL
`https://api.service.com/v1`

## Operations

### List Items
```
GET /items
Response: { items: [...] }
```

### Create Item
```
POST /items
Body: { name, description }
Response: { id, name, description }
```

### Get Item
```
GET /items/{id}
Response: { id, name, description }
```
```

### Webhook Integration Template
```yaml
---
name: webhook-service
description: Webhook-based service integration
---

# Webhook Integration

## Receiving Webhooks
- Endpoint: `/webhooks/service`
- Verification: [How to verify]
- Events: [List of events]

## Event Handlers

### on_event_type
```
Payload: { ... }
Action: [What to do]
```
```

## Common Integrations

### Communication APIs
- **Twilio:** SMS, voice calls, WhatsApp
- **SendGrid:** Email sending
- **Slack:** Messaging, notifications
- **Discord:** Bot messages, webhooks

### Productivity APIs
- **Google Calendar:** Events, scheduling
- **Notion:** Pages, databases
- **Todoist:** Tasks, projects
- **Linear:** Issues, projects

### Development APIs
- **GitHub:** Repos, PRs, issues
- **Vercel:** Deployments
- **Cloudflare:** DNS, workers

### AI/ML APIs
- **OpenAI:** GPT, embeddings, DALL-E
- **Anthropic:** Claude models
- **ElevenLabs:** Voice synthesis
- **Replicate:** Model hosting

## Security Guidelines

### Do
- Store credentials encrypted
- Use environment variables
- Implement rate limiting
- Log API usage (not secrets)

### Don't
- Echo API keys in responses
- Store credentials in code
- Ignore rate limits
- Make unnecessary API calls

## Credential Storage

Store in `~/.agent/credentials/`:
```
credentials/
├── github.enc
├── openai.enc
└── slack.enc
```

Access pattern:
```
1. Check if credential exists
2. Load and decrypt
3. Use for API call
4. Never log or display
```

## Error Handling Patterns

### Rate Limiting
```
if response.status == 429:
    wait_time = response.headers['Retry-After']
    sleep(wait_time)
    retry()
```

### Authentication Failure
```
if response.status == 401:
    notify_user("API key may be invalid or expired")
    suggest_reconfiguration()
```

### Service Unavailable
```
if response.status >= 500:
    retry_with_backoff(max_retries=3)
    if still_failing:
        notify_user("Service temporarily unavailable")
```

## References
- See `skill-creator` for skill creation patterns
- See `memory-manager` for logging integrations
- See `AUTONOMOUS_BOOTUP_SPEC.md` for architecture

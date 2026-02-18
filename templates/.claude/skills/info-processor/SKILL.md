# Info Processor

Intelligent information intake, classification, and routing system for knowledge management.

## What This Does

Takes incoming information (documents, research, data, insights) and intelligently routes it to the appropriate storage location for future retrieval and use.

## Information Flow

```
Input (any format)
    ↓
Classify (determine type & purpose)
    ↓
Route to appropriate storage
    ↓
Index for retrieval
    ↓
Confirm storage location
```

## Classification System

### 1. Operational Data
**Purpose**: Active transaction/entity data for portfolio operations
**Storage**: Mech Storage (PostgreSQL collections)
**Examples**:
- Entity profiles (companies, subsidiaries)
- Transactions (bank, payment processor)
- Health scores, reports
- Vendor rules

**Routing**:
```typescript
// Create via brain repository
await repo.createEntity({...})
await repo.createTransaction({...})
```

### 2. Strategic Knowledge
**Purpose**: Long-term reference, business wisdom, learned insights
**Storage**: `memory/long-term/`
**Examples**:
- Capital allocation principles
- Portfolio management strategies
- M&A criteria
- Financial analysis frameworks
- Industry insights

**Routing**:
```
memory/long-term/
├── capital-allocation.md
├── portfolio-strategy.md
├── ma-criteria.md
└── financial-frameworks.md
```

### 3. Reference Library
**Purpose**: External resources, research, documentation
**Storage**: `library/`
**Examples**:
- Business books (Berkshire letters already there)
- Industry reports
- Market research
- Competitor analysis
- Technical documentation

**Routing**:
```
library/
├── business-wisdom/
│   └── berkshire-hathaway/
├── industry-reports/
├── market-research/
└── technical-docs/
```

### 4. Session Context
**Purpose**: Current session activities, today's learnings
**Storage**: `memory/daily/YYYY-MM-DD.md`
**Examples**:
- Implementation progress
- Decisions made today
- Bugs fixed
- New patterns learned

**Routing**: Append to daily log with timestamp and context

### 5. Skills & Capabilities
**Purpose**: Permanent learned capabilities
**Storage**: `.claude/skills/<skill-name>/`
**Examples**:
- New API integrations
- Analysis frameworks
- Automation workflows
- Decision-making processes

**Routing**: Create new skill directory with SKILL.md

### 6. Configuration & Secrets
**Purpose**: Credentials, API keys, environment config
**Storage**: Mech Vault (encrypted)
**Examples**:
- API keys (Mercury, Stripe, etc.)
- SSH keys
- Environment variables
- Deployment secrets

**Routing**:
```typescript
await mech.createSecret({
  namespace: 'decisive/production',
  name: 'MERCURY_API_KEY',
  value: 'xxx'
})
```

## Usage

### Process Document

```
/info-processor "process this PDF about capital allocation strategies"
```

I will:
1. Read/extract content from document
2. Classify: Strategic Knowledge (capital allocation)
3. Route to: `memory/long-term/capital-allocation.md`
4. Index key concepts
5. Confirm storage location

### Process Research

```
/info-processor "research SaaS metrics and store for future use"
```

I will:
1. Research SaaS metrics (MRR, CAC, LTV, etc.)
2. Classify: Strategic Knowledge (financial frameworks)
3. Route to: `memory/long-term/saas-metrics.md`
4. Create structured reference
5. Confirm storage location

### Process Data

```
/info-processor "here's a CSV of transactions from our new entity"
```

I will:
1. Parse CSV
2. Classify: Operational Data (transactions)
3. Route to: Mech Storage via `repo.bulkCreateTransactions()`
4. Deduplicate, validate
5. Confirm import statistics

### Process Insight

```
/info-processor "I learned that AMZN charges often include AWS - categorize as mixed"
```

I will:
1. Extract pattern: AMZN → mixed (AWS + retail)
2. Classify: Operational Data (vendor rule)
3. Route to: Mech Storage as VendorRule
4. Update categorization logic
5. Confirm rule created

## Decision Tree

```
Is this operational data (entities, transactions, etc)?
├─ Yes → Mech Storage (via Repository)
└─ No ↓

Is this strategic knowledge (principles, frameworks)?
├─ Yes → memory/long-term/
└─ No ↓

Is this external reference (books, reports, docs)?
├─ Yes → library/
└─ No ↓

Is this session-specific (today's work)?
├─ Yes → memory/daily/
└─ No ↓

Is this a new capability (API, framework, process)?
├─ Yes → .claude/skills/
└─ No ↓

Is this sensitive (credentials, keys)?
├─ Yes → Mech Vault
└─ No → Ask for clarification
```

## Retrieval System

### By Type

**Operational Data**:
```typescript
// Via Repository
const entities = await repo.listEntities()
const transactions = await repo.listTransactions({ entityId })
```

**Strategic Knowledge**:
```bash
# Full-text search
grep -r "capital allocation" memory/long-term/
```

**Reference Library**:
```bash
# Use ask-buffett for Berkshire letters
/ask-buffett "capital allocation principles"

# Search other library content
find library/ -type f -name "*.md" -exec grep -l "SaaS metrics" {} \;
```

**Session Context**:
```bash
# Today's work
cat memory/daily/$(date +%Y-%m-%d).md

# Historical
ls memory/daily/ | head -10
```

**Skills**:
```bash
# List all skills
ls .claude/skills/

# Search skill content
grep -r "API integration" .claude/skills/
```

### By Semantic Search (Future)

Once vector search is implemented:
```typescript
// Find related knowledge
const results = await mech.vectorSearch({
  query: "How should I think about capital allocation?",
  collection: "memories",
  limit: 10
})
```

## Auto-Classification Hints

I look for these patterns to classify:

**Operational Data**:
- Transaction data, bank statements
- Entity profiles, company details
- Health metrics, financial data
- Vendor patterns, categorization rules

**Strategic Knowledge**:
- "Principles of...", "Framework for..."
- "How to think about...", "Approach to..."
- Investment criteria, decision frameworks
- Portfolio management strategies

**Reference Library**:
- Books, papers, reports
- External documentation
- Industry research, market analysis
- Competitor information

**Session Context**:
- "Today I learned...", "Fixed bug..."
- Implementation progress
- Temporary notes, TODOs

**Skills**:
- "How to integrate with..."
- New capability, automation
- Reusable process, framework

**Secrets**:
- API keys, passwords, tokens
- SSH keys, certificates
- Environment variables

## Storage Locations Summary

```
decisive_redux/
├── brain/lib/db/              # Code for accessing operational data
├── memory/
│   ├── MEMORY.md              # Core project context
│   ├── daily/                 # Session logs
│   └── long-term/             # Strategic knowledge
├── library/                   # External references
├── .claude/skills/            # Learned capabilities
└── [Mech Storage]             # Operational data (remote)
    └── [Mech Vault]           # Secrets (remote)
```

## Integration with Brain

The brain automatically stores certain data:

**Every Heartbeat**:
- Logs to `memories` collection (heartbeat_log type)
- Transaction imports to `transactions` collection
- Vendor rules to `vendor_rules` collection
- Health scores to `health_scores` collection

**On Demand** (via this skill):
- Strategic insights to `memory/long-term/`
- Research findings to `library/`
- New capabilities to `.claude/skills/`
- Configuration to Mech Vault

## Examples

### Example 1: Process Business Document

**Input**: "Process this Berkshire 2023 letter and extract capital allocation insights"

**Actions**:
1. Read letter content
2. Extract key insights about capital allocation
3. Classify: Strategic Knowledge
4. Route to: `memory/long-term/capital-allocation-berkshire.md`
5. Index key quotes and principles
6. Cross-reference with existing capital allocation knowledge

**Output**:
```
✓ Processed Berkshire 2023 letter
✓ Extracted 12 capital allocation insights
✓ Stored: memory/long-term/capital-allocation-berkshire.md
✓ Key themes: share buybacks, acquisitions, cash deployment
```

### Example 2: Process Transaction Data

**Input**: "Here's a Mercury CSV with 500 transactions from Q4 2025"

**Actions**:
1. Parse CSV format
2. Map to Transaction schema
3. Classify: Operational Data
4. Route to: Mech Storage via `bulkCreateTransactions()`
5. Deduplicate against existing transactions
6. Run AI categorization on uncategorized

**Output**:
```
✓ Parsed 500 transactions from CSV
✓ Imported 487 new transactions (13 duplicates)
✓ Stored in Mech Storage: transactions collection
✓ Categorized 487 transactions (12 new rules learned)
```

### Example 3: Process Research

**Input**: "Research best practices for SaaS metrics and store them"

**Actions**:
1. Research SaaS metrics (MRR, ARR, CAC, LTV, churn, etc.)
2. Compile frameworks and benchmarks
3. Classify: Strategic Knowledge
4. Route to: `memory/long-term/saas-metrics.md`
5. Structure with formulas and thresholds

**Output**:
```
✓ Researched SaaS metrics best practices
✓ Compiled 8 key metrics with formulas
✓ Stored: memory/long-term/saas-metrics.md
✓ Includes: MRR, CAC, LTV, churn, NRR, expansion
```

### Example 4: Process Insight

**Input**: "I noticed AWS charges from Amazon should be categorized as Infrastructure, not Shopping"

**Actions**:
1. Extract pattern: "AWS" in description → Infrastructure
2. Classify: Operational Data (vendor rule)
3. Route to: Mech Storage via `createVendorRule()`
4. Update existing Amazon rules or create new one
5. Apply retroactively to past transactions

**Output**:
```
✓ Created vendor rule: AWS → Infrastructure
✓ Pattern: /AWS|Amazon Web Services/i
✓ Confidence: 1.0 (manual rule)
✓ Applied retroactively: 23 transactions updated
```

## Keywords for Discovery

information management, knowledge management, data routing, document processing, information architecture, knowledge base, content organization, data classification, information intake, smart filing, knowledge storage

## Related Skills

- `/memory-manager` - Manage persistent memory
- `/knowledgebase` - Store and query knowledge
- `/library-search` - Search reference library
- `/ask-buffett` - Query Berkshire letters

---

**This skill makes me smarter over time.** Every document processed, every insight captured, every data point stored makes me more effective at managing the portfolio.

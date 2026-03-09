# GraphQL Setup Guide — Charity Navigator API
## Ihsan Labs · docs/graphql.md
<!-- VIBE-CODER: Update this file when API version changes, new query patterns are added, or auth flow changes -->

---

## What This Is

Charity Navigator exposes its nonprofit data through a GraphQL API. This guide walks you through everything you need — from getting an API key to running your first query to wiring it into the Ihsan scoring pipeline.

If you have never used GraphQL before, this guide starts from zero. Every command is copy-pasteable.

---

## Step 1 — Get Your API Key

1. Go to [https://www.charitynavigator.org/discover/api](https://www.charitynavigator.org/discover/api) and request developer access.
2. You will receive two credentials via email:
   - `app_id` — your application identifier
   - `app_key` — your secret key
3. Store them in your `.env` file immediately:

```env
CHARITY_NAVIGATOR_APP_ID=your_app_id_here
CHARITY_NAVIGATOR_APP_KEY=your_app_key_here
```

**Never commit these to git.** `.env` is already in `.gitignore`.

---

## Step 2 — Understand the Endpoint

Charity Navigator's GraphQL endpoint is:

```
https://api.charitynavigator.org/graphql
```

All requests are `POST`. Authentication is via query parameters (not headers):

```
POST https://api.charitynavigator.org/graphql?app_id=YOUR_ID&app_key=YOUR_KEY
Content-Type: application/json
```

---

## Step 3 — Your First Query (cURL)

Open a terminal and run this. Replace the credentials:

```bash
curl -X POST \
  "https://api.charitynavigator.org/graphql?app_id=YOUR_ID&app_key=YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "{ organizations(pageSize: 3, filters: { causeID: 3 }) { name ein overallScore } }"
  }'
```

`causeID: 3` is International Needs. You should get back a JSON array of three organizations with their names, EINs, and scores.

---

## Step 4 — Core Queries for Ihsan Labs

### 4.1 — Search organizations by cause and country

```graphql
query GetOrganizationsByCause(
  $causeID: Int!
  $pageSize: Int
  $pageNum: Int
) {
  organizations(
    pageSize: $pageSize
    pageNum: $pageNum
    filters: { causeID: $causeID }
  ) {
    charityID
    name
    ein
    tagLine
    websiteURL
    category {
      categoryID
      categoryName
    }
    cause {
      causeID
      causeName
    }
    currentRating {
      score
      ratingID
      publicationDate
    }
    advisories {
      severity
    }
    irsClassification {
      nteeCode
      nteeDescription
    }
  }
}
```

**Variables example:**
```json
{
  "causeID": 3,
  "pageSize": 20,
  "pageNum": 1
}
```

---

### 4.2 — Get full organization detail (for due diligence)

```graphql
query GetOrganizationDetail($ein: String!) {
  organization(ein: $ein) {
    charityID
    name
    ein
    tagLine
    websiteURL
    mailingAddress {
      city
      stateOrProvince
      country
    }
    currentRating {
      score
      ratingID
      publicationDate
      ratingImage {
        small
      }
      accountabilityAndTransparency
      financialHealth {
        workingCapitalRatio
        programExpenses
        adminExpenses
        fundraisingExpenses
        fundraisingEfficiency
        primaryRevenue
        totalRevenue
        totalExpenses
        totalAssets
        totalLiabilities
      }
    }
    advisories {
      severity
      headline
      body
    }
    irsClassification {
      nteeCode
      nteeDescription
      incomeAmount
      filingRequirement
    }
    category {
      categoryID
      categoryName
    }
    cause {
      causeID
      causeName
    }
  }
}
```

**Variables:**
```json
{ "ein": "13-1837418" }
```

---

### 4.3 — Batch query: top-rated orgs by focus area (used in Resonance Preview)

This is the query Ihsan runs on startup to warm the candidate cache (top 200 projects by region/focus).

```graphql
query GetTopRatedByFocus(
  $causeID: Int!
  $minScore: Float
  $pageSize: Int
) {
  organizations(
    pageSize: $pageSize
    filters: {
      causeID: $causeID
      ratingID: 4              # 4-star rated only
    }
  ) {
    charityID
    name
    ein
    tagLine
    currentRating {
      score
      accountabilityAndTransparency
    }
    advisories {
      severity
    }
  }
}
```

---

## Step 5 — Cause ID Reference

Use these `causeID` values to match the Ihsan `project_focus` enum:

| Ihsan Focus    | Charity Navigator causeID | causeName                           |
|----------------|---------------------------|--------------------------------------|
| `water`        | 3                         | International Needs                  |
| `education`    | 6                         | Education                            |
| `food`         | 10                        | Food Banks, Food Pantries, Food Dist.|
| `healthcare`   | 5                         | Health                               |
| `shelter`      | 4                         | Housing & Shelter                    |
| `orphan`       | 3                         | International Needs (sub-filter)     |
| `general`      | 1                         | Animals (adjust as needed)           |

---

## Step 6 — Node.js Integration (used by Ihsan API)

Install the dependency:

```bash
cd apps/api
pnpm add graphql-request
```

Create `apps/api/src/lib/charityNavigator.ts`:

```typescript
import { GraphQLClient, gql } from 'graphql-request';

const CN_ENDPOINT = 'https://api.charitynavigator.org/graphql';

function getClient() {
  const params = new URLSearchParams({
    app_id: process.env.CHARITY_NAVIGATOR_APP_ID!,
    app_key: process.env.CHARITY_NAVIGATOR_APP_KEY!,
  });
  return new GraphQLClient(`${CN_ENDPOINT}?${params.toString()}`);
}

// ─── Fetch top-rated orgs by cause ID ─────────────────────────
export async function getTopOrgsByCause(causeID: number, pageSize = 20) {
  const client = getClient();

  const query = gql`
    query GetTopRatedByFocus($causeID: Int!, $pageSize: Int) {
      organizations(
        pageSize: $pageSize
        filters: { causeID: $causeID }
      ) {
        charityID
        name
        ein
        tagLine
        currentRating {
          score
          accountabilityAndTransparency
        }
        advisories { severity }
      }
    }
  `;

  const data = await client.request<{ organizations: CNOrganization[] }>(
    query,
    { causeID, pageSize }
  );
  return data.organizations;
}

// ─── Fetch single org by EIN ───────────────────────────────────
export async function getOrgByEIN(ein: string) {
  const client = getClient();

  const query = gql`
    query GetOrgDetail($ein: String!) {
      organization(ein: $ein) {
        charityID
        name
        ein
        tagLine
        websiteURL
        currentRating {
          score
          accountabilityAndTransparency
          financialHealth {
            programExpenses
            adminExpenses
            fundraisingExpenses
            totalRevenue
            totalExpenses
            totalAssets
          }
        }
        advisories { severity headline body }
        category { categoryName }
        cause { causeName }
      }
    }
  `;

  const data = await client.request<{ organization: CNOrganization }>(
    query,
    { ein }
  );
  return data.organization;
}

// ─── Types ────────────────────────────────────────────────────
export interface CNOrganization {
  charityID: string;
  name: string;
  ein: string;
  tagLine?: string;
  websiteURL?: string;
  currentRating?: {
    score: number;
    accountabilityAndTransparency: number;
    financialHealth?: {
      programExpenses: number;
      adminExpenses: number;
      fundraisingExpenses: number;
      totalRevenue: number;
      totalExpenses: number;
      totalAssets: number;
    };
  };
  advisories?: Array<{ severity: string; headline?: string; body?: string }>;
  category?: { categoryName: string };
  cause?: { causeName: string };
}
```

---

## Step 7 — Caching Strategy

Charity Navigator data changes infrequently (weekly at most). Cache aggressively:

```typescript
// apps/api/src/lib/cnCache.ts
// Uses Supabase `organizations` table as cache layer.
// TTL: 7 days. On cache miss → fetch from CN API → upsert to DB.

export async function getCachedOrg(ein: string, supabase: SupabaseClient) {
  const { data } = await supabase
    .from('organizations')
    .select('*')
    .eq('ein', ein)
    .eq('source', 'charity_navigator')
    .gte('last_synced_at', new Date(Date.now() - 7 * 86400 * 1000).toISOString())
    .single();

  if (data) return data;

  // Cache miss: fetch and store
  const org = await getOrgByEIN(ein);
  await supabase.from('organizations').upsert({
    external_id: org.charityID,
    source: 'charity_navigator',
    name: org.name,
    ein: org.ein,
    website: org.websiteURL,
    overall_score: org.currentRating?.score,
    accountability_score: org.currentRating?.accountabilityAndTransparency,
    raw_data: org,
    last_synced_at: new Date().toISOString(),
  }, { onConflict: 'ein' });

  return org;
}
```

---

## Step 8 — Rate Limits & Error Handling

Charity Navigator enforces rate limits. Wrap all calls:

```typescript
// Retry with exponential backoff
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
  throw new Error('Max retries exceeded');
}
```

Common errors:
- `401` — Check `app_id` and `app_key` in query params (not headers).
- `429` — Rate limited. The `withRetry` wrapper handles this.
- Empty `organizations` array — The `causeID` may not match; check the cause table above.

---

## Step 9 — Testing Your Setup

Run the included test script:

```bash
bash scripts/test-charity-navigator.sh
```

This runs a basic search query and prints the first 3 results. If you see organization names and scores, your integration is working.

---

## Troubleshooting Checklist

| Symptom | Fix |
|---------|-----|
| `401 Unauthorized` | Credentials are in headers, not query params — move them to URL params |
| Empty results | Check causeID value against reference table in Step 5 |
| `Cannot read properties of undefined` | The `currentRating` field may be null for unrated orgs — add null checks |
| Stale data | Check `last_synced_at` in the `organizations` table; force a resync if > 7 days |

---
<!-- VIBE-CODER SECTION: Update these identifiers as integration evolves -->
<!-- [CN_API_VERSION]: v2 (as of 2025) -->
<!-- [LAST_VERIFIED]: 2025-01-01 -->
<!-- [ENDPOINT]: https://api.charitynavigator.org/graphql -->
<!-- [AUTH_METHOD]: query_params (app_id + app_key) -->
<!-- [CACHE_TTL_DAYS]: 7 -->

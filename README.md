# DNYANEX Advanced — Knowledge That Survives People

> **AI-Powered Knowledge Handover & Project Intelligence Platform**  
> *Advanced Development of the DNYANEX Hackathon Project*

DNYANEX Advanced is an AI-powered knowledge handover intelligence platform designed to reconstruct, verify, preserve, and transfer critical project knowledge. It uses evidence-based AI, source traceability, conflict detection, risk analysis, and human review to help organizations prevent valuable knowledge from being lost when team members leave.

---

## 1. Executive Summary

When developers, team leads, volunteers, or other team members leave an organization, critical project knowledge can disappear with them. Important information often remains scattered across Git commits, pull requests, issue discussions, meeting notes, and architecture documents.

Traditional AI summarization tools can produce fluent summaries but may also generate unsupported claims, assign incorrect task owners, overlook contradictory information, or expose sensitive credentials.

**DNYANEX follows an evidence-first approach:**

> A handover is not just a summary. It is a collection of verifiable, reviewable, and traceable knowledge claims.

Every extracted claim should include:

1. **Clear Statement:** An atomic assertion of project knowledge.
2. **Category:** DECISION, TASK, OWNER, RISK, DEPENDENCY, BLOCKER, NEXT_ACTION, OPEN_QUESTION, RECURRING_PROBLEM, or CONTACT_OR_RESOURCE.
3. **Supporting Source:** The original document or repository reference.
4. **Original Quotation:** The exact supporting text from the source.
5. **Evidence Verification:** Programmatic verification against original source content.
6. **Human Review:** Reviewer approval before publishing verified handover information.
7. **Audit History:** A record of extraction and reviewer actions.

---

## 2. Core Platform Modules

The platform is designed around the following capabilities. The availability of each capability depends on the current implementation.

- **Source Ingestion Hub:** Supports project knowledge collection from GitHub repositories and documents such as Markdown, TXT, CSV, and PDF.
- **Credential Redaction:** Detects and masks sensitive information such as API keys, tokens, and passwords before AI processing.
- **AI Knowledge Reconstruction:** Uses Google's Gemini models through the `@google/genai` SDK to extract structured project information.
- **Deterministic Evidence Verification:** Checks extracted quotations against original source content using exact text matching and character offsets.
- **Conflict and Contradiction Detection:** Identifies potentially inconsistent information across project sources and supports human reconciliation.
- **Risk, Blocker, and Knowledge Gap Analysis:** Helps identify unassigned tasks, unresolved blockers, dependencies, and missing project information.
- **Split-View Claim Ledger:** Displays extracted claims alongside their supporting source content.
- **Human Review Desk:** Provides reviewer workflows for approving, rejecting, clarifying, and resolving claims.
- **Role-Based Handover:** Organizes project knowledge for different roles, including incoming developers, project managers, and interns.
- **Successor Experience:** Helps incoming team members understand project context and acknowledge received handover information.
- **Guided Demonstration Mode:** Provides a structured demonstration using the CampusConnect project scenario.

---

## 3. Technology Stack

The current project technology stack includes:

| Layer | Technology |
|---|---|
| Frontend | React 19 |
| Styling | Tailwind CSS v4 |
| Icons | Lucide React |
| Backend | Node.js, Express |
| Language | TypeScript |
| Development Runtime | TSX |
| Build Tool | Vite |
| AI Integration | Google Gemini via `@google/genai` |
| Version Control | Git and GitHub |
| Deployment | Render |

---

## 4. Core Workflow

DNYANEX follows an evidence-oriented knowledge handover workflow:

1. **Connect:** Connect project repositories and upload relevant documents.
2. **Ingest:** Collect and preprocess available project information.
3. **Reconstruct:** Extract decisions, tasks, owners, risks, blockers, and dependencies.
4. **Verify:** Check extracted claims against original source evidence.
5. **Review:** Allow authorized reviewers to validate claims and resolve conflicts.
6. **Handover:** Organize approved project knowledge for incoming team members.
7. **Onboard:** Help successors understand project context and outstanding responsibilities.

---

## 5. Quick Start

### Prerequisites

- Node.js compatible with the project's dependencies.
- npm.
- A Google Gemini API key if AI-powered functionality requires it.

### Installation

Clone the repository:

```bash
git clone https://github.com/Sonakshi-Nazarkar/DNYANEX-Advanced.git
```

Navigate into the project:

```bash
cd DNYANEX-Advanced
```

Install dependencies:

```bash
npm install
```

Configure the required environment variables using the project's `.env.example` file.

Start the development server:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

Start the production server:

```bash
npm start
```

*Note: Available commands and required environment variables should be checked against the current `package.json`, `.env.example`, and project setup documentation.*

---

## 6. Hackathon Demonstration — CampusConnect Scenario

The CampusConnect scenario demonstrates how DNYANEX can preserve and transfer project knowledge when a team member departs.

The demonstration workflow includes:

1. **Explore Project:** Inspect project information and readiness indicators.
2. **Connected Sources:** Review connected repositories and project documents.
3. **AI Reconstruction:** Examine the knowledge extraction workflow.
4. **Claim Ledger:** Inspect extracted claims and their supporting evidence.
5. **Conflict Analysis:** Review contradictory information from different sources.
6. **Human Review:** Approve, reject, clarify, or reconcile claims.
7. **Role-Based Handover:** Prepare knowledge for an incoming team member.
8. **Successor Onboarding:** Review the handover information and acknowledge receipt.

---

## 7. Security and Reliability Principles

DNYANEX is designed around the following principles:

- Evidence-backed AI-generated claims.
- Source traceability and quotation verification.
- Sensitive credential protection.
- Human oversight before knowledge publication.
- Role-based access control.
- Transparent handling of conflicting or missing information.
- Auditable review and handover activities.

These principles help make project knowledge more trustworthy, accessible, and maintainable.

---

## 8. Future Development — Round 3 Roadmap

The next development phase is planned around three major improvements:

### 1. AI Project Knowledge Assistant

Introduce an evidence-grounded conversational assistant that answers questions about project architecture, decisions, tasks, and responsibilities using verified project sources. It should clearly identify questions that cannot be answered from available evidence.

### 2. Interactive Knowledge Dependency Graph

Develop an interactive graph connecting project decisions, tasks, owners, dependencies, blockers, and risks to make relationships between project components easier to understand.

### 3. Knowledge Drift and Risk Intelligence

Introduce mechanisms to identify outdated claims, changing responsibilities, conflicting updates, unresolved blockers, and missing project knowledge, with alerts and re-verification workflows.

*These are planned improvements, not claims of already completed functionality.*

---

## 9. Project Information

**Project Name:** DNYANEX Advanced — Knowledge That Survives People

**Team:** MahaMinds

**GitHub Repository:**  
https://github.com/Sonakshi-Nazarkar/DNYANEX-Advanced

**Live Application:**  
https://dnyanex-advanced.onrender.com

**Project Category:** AI / Knowledge Management / Project Intelligence

---

## 10. Project Vision

DNYANEX aims to make critical organizational knowledge survive beyond individual team members.

By combining evidence-based AI, structured knowledge extraction, human verification, and secure handover workflows, the platform aims to make project transitions more reliable and reduce knowledge loss.

**DNYANEX — Knowledge That Survives People.**

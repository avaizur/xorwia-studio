# 🛡️ XORWIA STUDIO | CI/CD Governance & Deployment Policy

This document defines the mandatory governance rules for deploying XORWIA STUDIO to AWS Lambda. Adherence to these rules is required to prevent deployment drift and maintain zero-downtime stability.

## 🏛️ Source of Truth
*   **The ONLY deployable directory is `apps/`**.
*   **The ONLY web source directory is `apps/web/`**.
*   Any `web/` directory at the project root or in other sub-folders is **FORBIDDEN** from production packaging and has been removed to prevent drift.

## 🌿 Branch Strategy
| Branch | Target Environment | Deployment Mode |
| :--- | :--- | :--- |
| `main` | **BLUE (Production)** | Atomic Alias Switch (via CI/CD) |
| `staging` | **GREEN (Pre-production)** | Continuous Staging (auto-deploy) |
| `feature/*` | **Development** | Manual review only |

## 🚀 Deployment Pipeline (Automated)
The following flow is the only accepted path to production:
1.  **Feature Development**: All changes developed in feature branches.
2.  **Staging Merge**: PR into `staging` branch triggers auto-pack of `apps/`.
3.  **GREEN Deployment**: Package deployed to Lambda and assigned to `green` alias.
4.  **Validation**: Manual or Automated testing on `green.xorwia.com`.
5.  **Production Promotion**: PR from `staging` into `main`.
6.  **BLUE Switchover**: `live` and `blue` aliases atomically updated to the new Version ID.

## 📦 Build & Packaging Rules
*   Builds must use the `scripts/deploy_xorwia.ps1` wrapper.
*   **Drift Protection**: The build script will fail if a root-level `web/` directory is detected.
*   **Versioning**: Every deployment must publish a new Lambda version to preserve rollback capability.
*   **Blue/Green**: Switchovers must happen via alias updates, never by overwriting the `$LATEST` code directly.

---
**Status**: 🛡️ POLICY ENFORCED | **Effective**: 2026-04-19

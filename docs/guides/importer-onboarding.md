# Importer Onboarding Guide

This guide walks a new importer through the full journey from account signup through KYC submission, registration, depositing funds, and setting up their first bond.

## 1. Account Signup

The first step is creating an account on the web application.

- Navigate to the signup page.
- Enter your work email and a secure password.
- Select the **Importer (CBP bondholder)** role. This role enables features like posting yield-bearing USDC collateral and configuring auto-top-up reserves.
- Click **Create account**. You will be automatically authenticated and redirected to the `/app` dashboard.

*Reference UI: `apps/web/app/signup/page.tsx`*

## 2. KYC Submission

Before performing any financial operations or registering bonds, you must complete the KYC (Know Your Customer) process.

- From the dashboard, navigate to the KYC section.
- Provide the required corporate details and upload necessary verification documents (e.g., business license, primary contact ID).
- Submit the form. The system will review your details (often via automated background checks or manual review by a surety admin).
- **API Reference:** [`POST /kyc/submit`](../api/openapi.yml)

## 3. Importer Registration

Once KYC is approved, complete your importer profile.

- Provide your Importer of Record (IOR) number.
- Set up your company profile.
- This creates your formal importer entity within the TariffShield system.
- **API Reference:** [`GET /importers`](../api/openapi.yml)

## 4. First Deposit

To back your continuous customs bond, you must deposit collateral.

- Navigate to the **Deposits/Collateral** section.
- Connect your preferred wallet or use a supported fiat on-ramp.
- Deposit USDC. These funds will be held in a yield-bearing contract (Stellar testnet for demos).
- Ensure you have sufficient funds to cover the required bond amount.

## 5. Setting up the First Bond

With funds deposited, you can now set up your customs bond.

- Go to the **Bonds** section.
- Create a new continuous bond request.
- The surety admin will review the request and, provided you have sufficient collateral deposited, sign the bond.
- Your bond is now active and will be monitored by the platform.
- **API Reference:** [`POST /bond-signatures`](../api/openapi.yml)

# Pocket Ledger — Personal Finance Tracker

A local-first, installable personal finance web app for Windows and iPhone. Built with HTML, CSS and vanilla JavaScript.

## Included features

- Fast transaction entry for income, expenses, transfers, money lent, money borrowed, collections and debt repayments.
- Separate cash, bank, e-wallet and credit-card accounts.
- Category budgets based on the categories in the supplied Personal Finance Budget Tracker workbook. Categories are flat; there are no subcategories.
- Installment and loan commitments, including amounts owed to you and amounts you owe.
- A daily **Safe to Spend** estimate.
- Visual dashboard: six-month income-vs-expense chart, spending-by-category donut, and color-coded financial status for cash flow, budgets, upcoming commitments and imported records requiring review. Charts update automatically from your saved transactions.
- Transaction search, CSV export, JSON backup and restore.
- Optional private cross-device sync using Supabase Auth and Row Level Security.
- Offline-capable PWA after the website has been opened once while online.
- Quick-link support for iPhone Shortcuts, e.g. `?quick=expense&amount=150&note=Lunch`.

## 1. Run locally on Windows

1. Extract this folder.
2. Open Command Prompt in this folder.
3. Run `python -m http.server 8000`.
4. On your computer, open `http://localhost:8000`.

The app can store data on the local device. To install it as a PWA and use it on an iPhone, publish it over HTTPS using the steps below. Opening `index.html` directly as a file is not the recommended way to run it because service workers require localhost or HTTPS.

## 2. Put it online (GitHub Pages)

1. Create a private or public repository on GitHub. A private repository is recommended because it contains your app source and configuration, although your entered finance data is stored separately in the browser / Supabase.
2. Upload the *contents* of this folder to the repository root: `index.html`, `app.js`, `styles.css`, `manifest.webmanifest`, `sw.js`, `icons/`, and the SQL / README files.
3. In GitHub, open **Settings → Pages**.
4. Under Build and deployment, choose **Deploy from a branch**, select `main` and `/ (root)`, then save.
5. Open the HTTPS website URL GitHub provides.

You can also host the folder on Netlify or another static HTTPS host. Do not place a Supabase service-role key in this website. The app only uses the public anon / publishable key and authenticated user sessions.

## 3. Install on iPhone

1. Open the published HTTPS URL in **Safari** on the iPhone.
2. Tap **Share** → **Add to Home Screen**.
3. Name it **Pocket Ledger** and tap **Add**. If iOS shows an **Open as Web App** option, turn it on.
4. Launch Pocket Ledger from the Home Screen. The Quick add button opens the transaction form; the amount field is first for fast entry.
5. Open the site once while online so the app shell can be cached for offline use.

The site must be hosted on HTTPS for the PWA installation and service worker to work correctly.

## 4. Optional iPhone Shortcuts for one-tap logging

The app accepts quick-log URL parameters. After publishing, replace `YOUR-SITE-URL` with your actual website address.

- Expense shortcut URL: `https://YOUR-SITE-URL/?quick=expense&amount=150&note=Lunch`
- Income shortcut URL: `https://YOUR-SITE-URL/?quick=income&amount=21931.96&note=Salary`

To make a shortcut:

1. Open Apple's **Shortcuts** app and tap **+**.
2. Add **Ask for Input** and select **Number** (for the amount).
3. Add a **URL** action and enter the corresponding URL above. Replace the sample `amount` with the **Provided Input** variable.
4. Add **Open URLs**.
5. Name the shortcut (for example, **Log Expense**) and add it to the Home Screen or a widget.

The URL pre-fills the transaction type and amount; you can complete the account, category and description in Pocket Ledger before saving. Avoid putting private transaction details in a URL that may be shared or stored in browser history.

## 5. Optional private cloud sync between iPhone and Windows

By default, data is stored locally on each device. To sync the same ledger between devices, configure a Supabase project:

1. Create a project at [supabase.com](https://supabase.com/).
2. In the Supabase dashboard, open **SQL Editor** and run the complete contents of `supabase.sql`.
3. In **Project Settings → API**, copy the **Project URL** and the public **anon / publishable key**. Never use or paste the service-role key into this app.
4. In Pocket Ledger → **Settings & sync**, enter the URL and public key.
5. Choose **Create cloud account** and use the same email/password on your iPhone and Windows computer. If email confirmation is enabled, confirm the email before signing in.
6. Sign in on the second device and tap **Sync now**. If the cloud copy is newer, the app asks whether to replace the local copy.

The SQL enables Row Level Security. Each signed-in user can read or update only their own snapshot. A successful sync stores one JSON snapshot per account. The sync strategy is last-write-wins; sync before switching devices, and avoid editing the same ledger offline on two devices at once. Keep JSON backups as an additional safeguard.

## 6. Import your existing Excel tracker

1. Open Settings & sync → **Import your existing Excel tracker**.
2. Select `Personal_Finance_Budget_Tracker.xlsm`.
3. Choose whether to replace the current transaction history or append the imported rows.

The importer reads the `Transactions`, `Budgets`, and `Lists & Setup` sheets. It preserves transaction descriptions, categories, dates, accounts and notes. Rows with review-like notes are flagged. It does **not** allocate the workbook's single combined opening cash/bank balance across accounts, and it does not guess the destination of any transfer. When importing history, set each account's opening balance as of the day **before the first imported transaction**. If you prefer to start tracking from today, do not import the old transaction history; set today's actual balances instead. Review flagged entries before relying on the calculated balances. The Excel import helper is loaded from a public CDN and therefore requires an internet connection when importing.

## How Safe to Spend is calculated

`(Cash + bank + e-wallet balances) − (credit-card outstanding) − (borrowed money still owed) − (payable installments due within 30 days) − (safety buffer)`.

That available amount is divided by the number of days remaining in the current month. A payable installment marked as already included in the card balance is excluded from the 30-day commitment deduction to avoid double counting. This is a conservative planning estimate, not a bank balance, financial advice or a guarantee. Keep account opening balances and commitments current.

## Data and privacy notes

- No transaction data is sent to a server unless you configure Supabase sync.
- Local data is stored in the browser on each device.
- The public Supabase key is intended for client-side use; the SQL policies, not key secrecy, protect each user's row.
- Use **Download backup** regularly. A JSON backup contains your transaction descriptions, accounts and balances, so store it securely.

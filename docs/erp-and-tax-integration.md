# Tax e-invoicing (JoFotara) and ERP integration

> الربط مع دائرة ضريبة الدخل والمبيعات (نظام الفوترة الوطني) ومع أنظمة الـ ERP مثل SAP.
> Everything here is switched on and configured by the owner from **إعدادات المالك** and **الربط مع الأنظمة**.

## 1. Tax on invoices

- Each invoice line belongs to a revenue line: `LAB`, `IMG`, `DEV`, `DOC`, `NRS`, or `FEE` (cancellation / no-show fees).
- **Settings → الضريبة** sets, per revenue line, the tax category (UN/ECE 5305) and rate:
  - `S`: standard rate, for example 16%.
  - `Z`: zero-rated.
  - `O`: exempt or out of scope.
- **Defaults:** medical services are `O` and devices and fees are `S` 16%. **Confirm with the company's tax adviser** before going live.
- **Prices include tax** (default yes): the quoted price is what the patient pays, and the tax is extracted from it. When set to no, the tax is added on top and split between payer and patient in proportion.
- Every line stores its net amount, tax category, rate, tax amount and gross amount. Every invoice stores its subtotal, total tax and total.

## 2. Jordan national e-invoicing (JoFotara)

| Setting | Meaning |
|---|---|
| ربط الفواتير مع دائرة الضريبة | `متوقف` / `تجريبي` (mock, nothing leaves the server) / `JoFotara` |
| رابط الإرسال | Default `https://backend.jofotara.gov.jo/core/invoices/` |
| Client ID / Secret Key | From the JoFotara portal → device linking (ربط الأجهزة). Each income-source sequence has its own pair. Stored **encrypted** (AES-256-GCM, key from the `HC_SECRET_KEY` environment variable) and never shown again. |
| الرقم الضريبي، اسم الشركة، تسلسل مصدر الدخل | Seller data printed in every document |
| إرسال تلقائي عند الإصدار | Submit as soon as an invoice is issued |
| نوع الفاتورة | Cash (`011`) / receivable (`021`) / automatic (cash when fully paid at issue) |

**Flow**
1. An invoice is issued, either at the end of a direct visit or when Finance issues a periodic invoice.
2. The e-invoice is queued with a fixed UUID and an ICV counter.
3. The server builds UBL 2.1 XML (`backend/src/einvoice/ubl.ts`). A negative invoice becomes a credit note (`381`) that references the patient's last accepted invoice.
4. The XML is posted base64-encoded as `{"invoice": "…"}`, with the `Client-Id` and `Secret-Key` headers.
5. The tax system's response decides what happens next:
   - **Accepted:** the returned `EINV_QR` and `EINV_NUM` are stored. The QR is printed on the tax invoice (Finance screen, patient app, ERP API).
   - **Rejected (4xx):** the reason is shown to Finance, who fixes the data and resends.
   - **Outage (5xx or timeout):** the server retries automatically after 1, 5, 15, 60 and 240 minutes.
6. Finance → **الفوترة الإلكترونية** lists each document's status, the rejection reason, and issued invoices that were never sent.

> ⚠️ The XML follows the published structure of the ISTD technical guide: `ProfileID reporting:1.0`, ICV, seller sequence, tax categories, credit notes with `BillingReference`. Validate a first live invoice with the ISTD sandbox or an accountant before switching every invoice to live. If the tax department changes the format, the only file to update is `ubl.ts`.

## 3. ERP API (SAP and others)

Base URL: `https://<server>/api/erp/v1`. The OpenAPI 3.0 description is at `/api/erp/v1/openapi.json`; import it into SAP Integration Suite, Postman or a client generator.

**Authentication:** the owner creates an API key under **الربط مع الأنظمة** and chooses its scopes. Send it as `Authorization: Bearer hc_…` or `X-API-Key: hc_…`. The key is shown only once, only its hash is stored, and it can be revoked at any time.

| Endpoint | Scope | Use |
|---|---|---|
| `GET /invoices?updatedSince=&unsynced=true&cursor=` | invoices:read | Incremental export: lines with tax, G/L account, ERP tax code, cost center, customer, payer, payments, e-invoice UUID/number/QR |
| `GET /invoices/{id or number}` · `GET /invoices/{id}/qr.svg` | invoices:read | One document · tax QR image |
| `POST /invoices/{id}/ack` `{erpDocumentNo}` | invoices:ack | ERP confirms the posting (e.g. SAP FI document number); the invoice leaves the `unsynced` list |
| `GET /payments?afterId=` | payments:read | Payments collected in the field and in the office |
| `POST /payments` + `Idempotency-Key` | payments:write | Payment received in the ERP (bank transfer, insurer settlement); the same key never posts twice |
| `GET /customers` · `PUT /customers/{id}` `{erpCode}` | customers:read / write | Billing identity only (no clinical data); store the SAP Business Partner number |
| `GET /payers` · `PUT /payers/{id}` | customers:read / write | Insurers and their ERP numbers |
| `GET /services` | catalog:read | Catalogue with cash price, tax and G/L mapping |
| `GET /events?afterId=` | events:read | Event feed for systems that poll instead of receiving webhooks |

**Amounts:** the API sends every amount both as a JOD string with 3 decimals (`"12.500"`) and as integer fils (`12500`).

**Webhooks:** **إعدادات المالك → ربط ERP** sets the receiving URL and the signing secret.
- **Events:** `invoice.issued`, `invoice.paid`, `payment.created`, `einvoice.accepted`, `einvoice.rejected`.
- **Headers:** `X-HC-Event`, `X-HC-Delivery`, and `X-HC-Signature: sha256=<HMAC of the raw body>`.
- **Retries:** after 1, 5, 15, 60, 240 and 720 minutes.

### Suggested SAP S/4HANA mapping (via SAP Integration Suite / CPI)

| Home Care | SAP |
|---|---|
| `customer.erpCode` (set with `PUT /customers/{id}`) | Business Partner / customer (KUNNR) |
| `payer.erpCode` | Insurer as customer; post `totals.payerShare` to the insurer and `totals.patientShare` to the patient |
| `lines[].glAccount` (setting حساب الإيراد لكل نوع خدمة) | Revenue G/L account |
| `lines[].tax.erpTaxCode` (setting رمز الضريبة بالـ ERP) | Tax code (MWSKZ) |
| `costCenter` | Cost center / profit center |
| `number`, `eInvoice.uuid`, `eInvoice.number` | Reference (XBLNR) and assignment fields |
| `POST /invoices/{id}/ack` | Write back the FI document number (BELNR) |
| `POST /payments` | Incoming payment (F-28 / bank statement) mirrored back so the patient file shows it as paid |

A typical CPI iFlow works like this:
1. Every 15 minutes, call `GET /invoices?unsynced=true`.
2. Map each invoice to `JournalEntryCreateRequest` or a billing document.
3. Post it.
4. Call `ack` with the document number.

Payments can come back through the `payment.created` webhook, or the ERP can post them with `POST /payments`.

## 4. Stock in the ERP (check before dispensing, goods issue after)

Owner settings → **المخزون (ERP)**:

| Setting | Meaning |
|---|---|
| فحص المخزون قبل الصرف | `متوقف` / `تجريبي` (a demo warehouse inside the app) / `ERP عام (REST)` / `SAP S/4HANA (OData)` |
| إذا الكمية مش كافية | **Block** the dispense (default) or **allow with a warning** |
| إذا الـ ERP ما رد | **Allow** and post the goods issue later (default), or **block** |
| رابط الـ ERP، اسم المستخدم، كلمة السر أو المفتاح | With a user: Basic auth. Without one: Bearer token. The key is stored encrypted |
| Plant، Storage Location، Movement Type، مركز الكلفة | Where stock is taken from. SAP movement type `201` (goods issue to cost center) by default |
| رقم المادة بالـ ERP لكل خدمة | Material for each service, e.g. `DEV-O2` → oxygen concentrator material. Only mapped services are checked |

**When the check happens:**
- When a **pharmacy**, **equipment** or **lab** order is completed from the department worklist.
- When a **direct visit** is completed. A rented device counts as one unit; its quantity is the rental days, which is not stock.

**What the users see:**
- The pharmacist and the driver see the availability **before** pressing "اعتماد وإرسال".
- The pharmacist can list the exact materials and quantities dispensed. They override the mapped material.

**After the dispense:**
1. A goods issue is queued (`stock_movements`).
2. The background job posts it to the ERP and stores the ERP document number.
3. A failed post is retried after 1, 5, 15, 60 and 240 minutes.
4. A successful post emits the `stock.issued` event.

The owner's **الربط مع الأنظمة** screen lists the movements and their status, and offers "أرسل المعلّق الآن".

### Generic REST contract (any ERP)

```
GET  {base}/stock?material=MAT-1&plant=1000&location=0001        →  {"material":"MAT-1","available":12}
POST {base}/goods-issues                                          →  {"documentNo":"GI-778"}
     {"reference":"ORDER-12","plant":"1000","location":"0001","movementType":"201","costCenter":"HC-AMM",
      "items":[{"material":"MAT-1","qty":1}]}
```

### SAP S/4HANA

- **Availability:** `GET /sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod?$filter=Material eq '…' and Plant eq '…' and StorageLocation eq '…' and InventoryStockType eq '01'` sums `MatlWrhsStkQtyInMatlBaseUnit`. That is unrestricted stock.
- **Goods issue:** first `GET` with `x-csrf-token: fetch`, then `POST /sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader`. The body has `GoodsMovementCode` `03`, one `to_MaterialDocumentItem` per material with the plant, storage location, movement type and cost center, and the reference as the header text. The returned `MaterialDocument` is stored.
- **Validate before go-live:** check the communication arrangement, the user's authorizations and the movement type with the SAP team. These APIs need the SAP communication scenarios for material stock and material documents.

// OpenAPI 3.0 description of the ERP API, served at /api/erp/v1/openapi.json.
// Import it into SAP Integration Suite (API Management / Cloud Integration), Postman or any client generator.

const money = { type: 'object', properties: { amount: { type: 'string', example: '12.500', description: 'JOD, 3 decimals' }, fils: { type: 'integer', example: 12500 } } };
const err = { description: 'Error', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } } };
const cursorParams = [
  { name: 'updatedSince', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Only rows changed at or after this time' },
  { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'nextCursor from the previous page' },
  { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } },
];
const ok = (schema: object) => ({ description: 'OK', content: { 'application/json': { schema } } });
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Home Care ERP API',
    version: '1.0.0',
    description:
      'Pull invoices (with tax, e-invoice UUID and QR), payments, customers and the service catalogue into an ERP; ' +
      'post payments received in the ERP; confirm postings. Events are also pushed by webhook (signed with HMAC-SHA256 in X-HC-Signature) ' +
      'or can be polled from /events. Create API keys in the owner settings (Integrations).',
  },
  servers: [{ url: '/api/erp/v1' }],
  security: [{ bearer: [] }, { apiKey: [] }],
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', description: 'API key: Authorization: Bearer hc_…' },
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    },
    schemas: {
      Money: money,
      InvoiceLine: {
        type: 'object',
        properties: {
          lineNo: { type: 'integer' }, sourceType: { type: 'string', enum: ['VISIT', 'SHIFT', 'SHIFT_PLANNED', 'SHIFT_ADJUST', 'RENTAL', 'SUPPLY'] },
          serviceCode: { type: 'string', nullable: true }, description: { type: 'string' }, quantity: { type: 'number' },
          unitPrice: money, net: money, gross: money, payerShare: money, patientShare: money,
          tax: { type: 'object', properties: { category: { type: 'string', enum: ['S', 'Z', 'O'] }, rate: { type: 'number' }, amount: money, erpTaxCode: { type: 'string', nullable: true } } },
          glAccount: { type: 'string', nullable: true }, revenueLine: { type: 'string', enum: ['LAB', 'IMG', 'DEV', 'DOC', 'NRS', 'FEE'] },
        },
      },
      Invoice: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, number: { type: 'string', example: 'INV-000042' }, kind: { type: 'string', enum: ['VISIT', 'PERIODIC', 'FINAL'] },
          documentType: { type: 'string', enum: ['INVOICE', 'CREDIT_NOTE'] }, status: { type: 'string', enum: ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID'] },
          currency: { type: 'string', example: 'JOD' }, issuedAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
          period: { type: 'object', nullable: true, properties: { from: { type: 'string' }, to: { type: 'string' } } },
          customer: { type: 'object', properties: { id: { type: 'integer' }, erpCode: { type: 'string', nullable: true }, nationalId: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' } } },
          payer: { type: 'object', nullable: true, properties: { id: { type: 'integer' }, erpCode: { type: 'string', nullable: true }, name: { type: 'string' }, type: { type: 'string' }, memberNo: { type: 'string' } } },
          totals: { type: 'object', properties: { net: money, tax: money, gross: money, payerShare: money, patientShare: money, paid: money } },
          pricesIncludeTax: { type: 'boolean' }, costCenter: { type: 'string', nullable: true },
          lines: { type: 'array', items: ref('InvoiceLine') },
          payments: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, method: { type: 'string' }, amount: money, reference: { type: 'string' }, receivedAt: { type: 'string' } } } },
          eInvoice: {
            type: 'object', nullable: true, description: 'Jordan national e-invoicing (JoFotara) result',
            properties: { status: { type: 'string', enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'FAILED'] }, uuid: { type: 'string' }, icv: { type: 'integer' }, number: { type: 'string' }, qr: { type: 'string', description: 'QR payload returned by the tax authority' }, documentType: { type: 'string', enum: ['388', '381'] }, message: { type: 'string', nullable: true } },
          },
          erp: { type: 'object', properties: { documentNo: { type: 'string', nullable: true }, syncedAt: { type: 'string', nullable: true } } },
        },
      },
      Event: { type: 'object', properties: { id: { type: 'integer' }, event: { type: 'string', enum: ['invoice.issued', 'invoice.paid', 'invoice.voided', 'payment.created', 'payer_payment.created', 'einvoice.accepted', 'einvoice.rejected', 'rental.returned', 'episode.closed'] }, occurredAt: { type: 'string' }, data: { type: 'object' } } },
    },
  },
  paths: {
    '/invoices': {
      get: {
        summary: 'Issued invoices and credit notes changed since a time (scope invoices:read)',
        parameters: [...cursorParams,
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'unsynced', in: 'query', schema: { type: 'boolean' }, description: 'Only invoices the ERP has not acknowledged yet' }],
        responses: { 200: ok({ type: 'object', properties: { data: { type: 'array', items: ref('Invoice') }, nextCursor: { type: 'string', nullable: true } } }), 401: err, 403: err },
      },
    },
    '/invoices/{id}': { get: { summary: 'One invoice by id or number', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok(ref('Invoice')), 404: err } } },
    '/invoices/{id}/qr.svg': { get: { summary: 'Tax authority QR code as SVG', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'SVG', content: { 'image/svg+xml': {} } }, 404: err } } },
    '/invoices/{id}/ack': {
      post: {
        summary: 'Confirm the ERP posted the invoice (scope invoices:ack)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['erpDocumentNo'], properties: { erpDocumentNo: { type: 'string', example: '1800000123' } } } } } },
        responses: { 200: ok({ type: 'object' }), 404: err },
      },
    },
    '/payments': {
      get: {
        summary: 'Payments after an id (scope payments:read)',
        parameters: [{ name: 'afterId', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: { 200: ok({ type: 'object' }) },
      },
      post: {
        summary: 'Record a payment received in the ERP (scope payments:write). method INSURER applies it to the insurer share. Idempotent per Idempotency-Key.',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: {
            invoiceId: { type: 'integer' }, invoiceNo: { type: 'string' }, amount: { type: 'string', example: '25.000' },
            method: { type: 'string', enum: ['TRANSFER', 'CARD', 'CASH', 'CLIQ', 'LINK', 'INSURER'] }, reference: { type: 'string' }, receivedAt: { type: 'string', format: 'date-time' },
          } } } },
        },
        responses: { 201: ok({ type: 'object' }), 400: err, 404: err, 409: err },
      },
    },
    '/customers': { get: { summary: 'Customers (billing identity only, no clinical data) (scope customers:read)', parameters: cursorParams, responses: { 200: ok({ type: 'object' }) } } },
    '/customers/{id}': { put: { summary: 'Store the ERP customer number (scope customers:write)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { erpCode: { type: 'string' } } } } } }, responses: { 200: ok({ type: 'object' }) } } },
    '/payers': { get: { summary: 'Insurers and other payers (scope customers:read)', responses: { 200: ok({ type: 'object' }) } } },
    '/payers/{id}': { put: { summary: 'Store the ERP number of a payer (scope customers:write)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { erpCode: { type: 'string' } } } } } }, responses: { 200: ok({ type: 'object' }) } } },
    '/services': { get: { summary: 'Service catalogue with cash price, tax and G/L mapping (scope catalog:read)', responses: { 200: ok({ type: 'object' }) } } },
    '/events': { get: { summary: 'Business events after an id, for polling instead of webhooks (scope events:read)', parameters: [{ name: 'afterId', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { 200: ok({ type: 'object', properties: { data: { type: 'array', items: ref('Event') }, nextAfterId: { type: 'integer' } } }) } } },
  },
};

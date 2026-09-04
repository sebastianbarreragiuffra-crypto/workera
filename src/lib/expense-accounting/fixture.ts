import type { Json } from "@/lib/supabase/database.types";

export const validAccountingPayload = {
  schemaVersion: 1,
  provider: "LEDGER_CSV_V1",
  company: { id: "10000000-0000-4000-8000-000000000001", name: "Arcotex" },
  report: {
    id: "10000000-0000-4000-8000-000000000002",
    referenceNumber: "REN-2026-001",
    title: "Visita a obra",
    currency: "CLP",
    totalAmount: 11900,
    paidAt: "2026-09-04T15:00:00Z",
    paymentReference: "PAGO-001",
    submitterId: "10000000-0000-4000-8000-000000000003",
    submitterName: "Persona Uno",
    costCenterCode: "OBRA-1",
    costCenterName: "Obra Uno",
  },
  lines: [{
    itemId: "10000000-0000-4000-8000-000000000004",
    expenseDate: "2026-09-03",
    categoryCode: "TRANSPORTE",
    categoryName: "Transporte",
    merchant: "Taxi",
    description: "Traslado",
    netAmount: 10000,
    taxAmount: 1900,
    totalAmount: 11900,
    currency: "CLP",
  }],
} satisfies Json;

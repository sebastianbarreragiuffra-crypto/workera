import { Badge } from "@/components/shell/Badge";
import type { ExpenseReportStatus } from "@/lib/expenses/data";
import { EXPENSE_STATUS_LABEL, expenseStatusTone } from "@/lib/expenses/presentation";

export function ExpenseStatusBadge({ status }: { status: ExpenseReportStatus }) {
  return <Badge label={EXPENSE_STATUS_LABEL[status]} tone={expenseStatusTone(status)} />;
}

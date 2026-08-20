"use client";

import type { ProductionMealDiscountRecord } from "./types";

function asExcelDate(dateIso: string): Date {
  return new Date(`${dateIso}T12:00:00`);
}

function groupByWorker(records: ProductionMealDiscountRecord[]) {
  const groups = new Map<string, ProductionMealDiscountRecord[]>();
  for (const record of records) {
    const current = groups.get(record.workerName) ?? [];
    current.push(record);
    groups.set(record.workerName, current);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "es"))
    .map(([name, workerRecords]) => ({
      name,
      records: workerRecords.sort((a, b) => a.date.localeCompare(b.date)),
      total: workerRecords.reduce((sum, record) => sum + record.amount, 0),
    }));
}

export async function downloadProductionDiscountExcel({
  records,
  title,
  filename,
  periodLabel,
}: {
  records: ProductionMealDiscountRecord[];
  title: string;
  filename: string;
  periodLabel: string;
}) {
  const XLSX = await import("xlsx");
  const groups = groupByWorker(records);
  const detailRows: unknown[][] = [[], [null, title], [null, "Nombre", "Fecha", "Monto", "Total a Pagar", "Firma"]];
  const merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [{ s: { r: 1, c: 1 }, e: { r: 1, c: 5 } }];
  const workerTotalRows: Array<{ row: number; start: number; end: number; total: number }> = [];

  for (const group of groups) {
    const startRow = detailRows.length + 1;
    group.records.forEach((record, index) => {
      detailRows.push([null, index === 0 ? group.name : null, asExcelDate(record.date), record.amount, null, null]);
    });
    const endRow = detailRows.length;
    merges.push(
      { s: { r: startRow - 1, c: 1 }, e: { r: endRow - 1, c: 1 } },
      { s: { r: startRow - 1, c: 4 }, e: { r: endRow - 1, c: 4 } },
      { s: { r: startRow - 1, c: 5 }, e: { r: endRow - 1, c: 5 } },
    );
    workerTotalRows.push({ row: startRow, start: startRow, end: endRow, total: group.total });
  }

  const totalRow = detailRows.length + 1;
  const grandTotal = records.reduce((sum, record) => sum + record.amount, 0);
  detailRows.push([null, "TOTAL DESCUENTOS", null, null, grandTotal, null]);
  merges.push({ s: { r: totalRow - 1, c: 1 }, e: { r: totalRow - 1, c: 3 } });

  const detailSheet = XLSX.utils.aoa_to_sheet(detailRows, { cellDates: true });
  detailSheet["!merges"] = merges;
  detailSheet["!cols"] = [{ wch: 3 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 34 }];
  for (let row = 4; row < totalRow; row += 1) {
    if (detailSheet[`C${row}`]) detailSheet[`C${row}`].z = "dd-mmm";
    if (detailSheet[`D${row}`]) detailSheet[`D${row}`].z = '"$"#,##0';
  }
  for (const worker of workerTotalRows) {
    detailSheet[`E${worker.row}`] = { t: "n", v: worker.total, f: `SUM(D${worker.start}:D${worker.end})`, z: '"$"#,##0' };
  }
  detailSheet[`E${totalRow}`] = { t: "n", v: grandTotal, f: `SUM(D4:D${totalRow - 1})`, z: '"$"#,##0' };

  const summaryRows: unknown[][] = [
    [title],
    [periodLabel],
    [],
    ["Nombre Trabajador", "Almuerzos", "Total descuento", "Firma"],
    ...groups.map((group) => [group.name, group.records.length, group.total, null]),
    ["TOTAL DESCUENTOS", records.length, grandTotal, null],
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 3 } },
  ];
  summarySheet["!cols"] = [{ wch: 30 }, { wch: 14 }, { wch: 18 }, { wch: 34 }];
  for (let row = 5; row <= summaryRows.length; row += 1) {
    if (summarySheet[`C${row}`]) summarySheet[`C${row}`].z = '"$"#,##0';
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, summarySheet, "Resumen");
  XLSX.utils.book_append_sheet(workbook, detailSheet, "Descuento");
  XLSX.writeFile(workbook, filename, { compression: true });
}

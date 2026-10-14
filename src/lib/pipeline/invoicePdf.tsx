import React from "react";
import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";

export type InvoicePdfLine = {
  itemName: string;
  quantity: number;
  unit: string;
  unitPricePaise: number;
  lineTotalPaise: number;
  gstRatePercent: number;
  taxablePaise: number;
  gstPaise: number;
};

export type InvoicePdfData = {
  shopName: string;
  shopAddress: string | null;
  shopGstin: string | null;
  invoiceNumber: string;
  dateLabel: string;
  customerName: string | null;
  lines: InvoicePdfLine[];
  totalPaise: number;
};

function pdfRupees(paise: number): string {
  const hasPaise = paise % 100 !== 0;
  return `Rs ${(paise / 100).toFixed(hasPaise ? 2 : 0)}`;
}

function qtyLabel(quantity: number, unit: string): string {
  return `${quantity} ${unit}`;
}

function taxSummary(lines: InvoicePdfLine[]): Array<{
  rate: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
}> {
  const byRate = new Map<number, { taxablePaise: number; cgstPaise: number; sgstPaise: number }>();
  for (const line of lines) {
    const entry = byRate.get(line.gstRatePercent) ?? { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 };
    entry.taxablePaise += line.taxablePaise;
    entry.cgstPaise += Math.floor(line.gstPaise / 2);
    entry.sgstPaise += line.gstPaise - Math.floor(line.gstPaise / 2);
    byRate.set(line.gstRatePercent, entry);
  }
  return [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, entry]) => ({ rate, ...entry }));
}

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 36, paddingHorizontal: 40, fontSize: 9, fontFamily: "Helvetica", color: "#111" },
  header: { marginBottom: 14 },
  shopName: { fontSize: 16, fontFamily: "Helvetica-Bold" },
  muted: { color: "#444" },
  metaRow: { flexDirection: "row", justifyContent: "space-between", marginVertical: 10 },
  sectionTitle: { fontSize: 11, fontFamily: "Helvetica-Bold", marginBottom: 6 },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#111",
    paddingBottom: 3,
    marginBottom: 3,
    fontFamily: "Helvetica-Bold",
  },
  tableRow: { flexDirection: "row", paddingVertical: 2 },
  colItem: { width: "40%" },
  colQty: { width: "18%" },
  colRate: { width: "20%" },
  colAmt: { width: "22%", textAlign: "right" },
  totalsBlock: { marginTop: 12, marginLeft: "auto", width: "50%" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 1 },
  grandRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: "#111",
    marginTop: 4,
    paddingTop: 4,
    fontFamily: "Helvetica-Bold",
  },
  summaryRow: { flexDirection: "row", paddingVertical: 1 },
});

function InvoiceDocument(props: { data: InvoicePdfData }): React.ReactElement {
  const { data } = props;
  const summary = taxSummary(data.lines);
  const taxableTotal = data.lines.reduce((sum, line) => sum + line.taxablePaise, 0);
  const cgstTotal = summary.reduce((sum, row) => sum + row.cgstPaise, 0);
  const sgstTotal = summary.reduce((sum, row) => sum + row.sgstPaise, 0);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.shopName}>{data.shopName}</Text>
          {data.shopAddress ? <Text style={styles.muted}>{data.shopAddress}</Text> : null}
          {data.shopGstin ? <Text style={styles.muted}>GSTIN: {data.shopGstin}</Text> : null}
        </View>

        <View style={styles.metaRow}>
          <View>
            <Text style={styles.sectionTitle}>Invoice</Text>
            <Text>No: {data.invoiceNumber}</Text>
            <Text>Date: {data.dateLabel}</Text>
          </View>
          <View>
            <Text style={styles.sectionTitle}>Customer</Text>
            <Text>{data.customerName ?? "Walk-in"}</Text>
          </View>
        </View>

        <View style={styles.tableHeader}>
          <Text style={styles.colItem}>Item</Text>
          <Text style={styles.colQty}>Qty</Text>
          <Text style={styles.colRate}>Rate</Text>
          <Text style={styles.colAmt}>Amount</Text>
        </View>
        {data.lines.map((line, index) => (
          <View style={styles.tableRow} key={`${line.itemName}-${index}`}>
            <Text style={styles.colItem}>{line.itemName}</Text>
            <Text style={styles.colQty}>{qtyLabel(line.quantity, line.unit)}</Text>
            <Text style={styles.colRate}>{pdfRupees(line.unitPricePaise)}</Text>
            <Text style={styles.colAmt}>{pdfRupees(line.lineTotalPaise)}</Text>
          </View>
        ))}

        <View style={styles.totalsBlock}>
          <View style={styles.totalRow}>
            <Text>Taxable</Text>
            <Text>{pdfRupees(taxableTotal)}</Text>
          </View>
          {summary.map((row) => (
            <View style={styles.summaryRow} key={row.rate}>
              <Text style={{ width: "40%" }}>GST {row.rate}% (CGST+SGST)</Text>
              <Text style={{ width: "60%", textAlign: "right" }}>{pdfRupees(row.cgstPaise + row.sgstPaise)}</Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text>CGST</Text>
            <Text>{pdfRupees(cgstTotal)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text>SGST</Text>
            <Text>{pdfRupees(sgstTotal)}</Text>
          </View>
          <View style={styles.grandRow}>
            <Text>Total</Text>
            <Text>{pdfRupees(data.totalPaise)}</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const buffer = await renderToBuffer(<InvoiceDocument data={data} />);
  return Buffer.from(buffer);
}

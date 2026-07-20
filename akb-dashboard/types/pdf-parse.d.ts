// Deep-path import declaration for pdf-parse: the package root runs a
// debug self-test on import outside its own repo (known quirk), so the
// deal-docs route imports lib/pdf-parse.js directly.
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: Record<string, unknown>;
  }
  function pdfParse(buffer: Buffer, options?: Record<string, unknown>): Promise<PdfParseResult>;
  export default pdfParse;
}

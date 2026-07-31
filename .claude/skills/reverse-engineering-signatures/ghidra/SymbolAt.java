// Ghidra Java post-script: print the symbols defined AT each given RVA (plus the
// containing function/data, if any). The inverse of ListSymbols.java, which
// searches names -> addresses; this maps addresses -> names.
//
// THE query for "what class does this vtable RVA belong to", which is how you
// relocate a hardcoded vtable list after a game patch: read the names off the OLD
// analyzed DB, then find those classes again in the new binary.
// Needs RTTI/demangled names, so run against the ANALYZED DB (gbfr<ver>fast).
//
// Args: one or more RVAs (hex, with or without 0x), e.g.:
//   -postScript SymbolAt.java 0x5c58dd0 0x59c61d0
//
// Output: one block per RVA. Filter with: grep 'SymbolAt.java>'
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Symbol;

public class SymbolAt extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args == null || args.length == 0) { println("need RVA arg(s)"); return; }
        for (String s : args) {
            long r = Long.parseLong(s.replaceFirst("^0[xX]", ""), 16);
            Address a = currentProgram.getImageBase().add(r);
            StringBuilder sb = new StringBuilder("rva=0x" + Long.toHexString(r) + " ");
            Symbol[] syms = currentProgram.getSymbolTable().getSymbols(a);
            if (syms != null && syms.length > 0) {
                for (Symbol sym : syms) sb.append("[").append(sym.getName(true)).append("] ");
            } else {
                sb.append("(no symbol) ");
            }
            Function fn = currentProgram.getFunctionManager().getFunctionContaining(a);
            if (fn != null) sb.append(" inFn=").append(fn.getName());
            Data d = currentProgram.getListing().getDataContaining(a);
            if (d != null) sb.append(" data=").append(d.getPathName()).append(":").append(d.getDataType().getName());
            println(sb.toString());
        }
        println("=== done ===");
    }
}

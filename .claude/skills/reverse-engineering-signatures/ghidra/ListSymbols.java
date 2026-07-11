// Ghidra Java post-script: search the symbol table (incl. RTTI-derived class/vtable
// names) for a case-insensitive substring and print each match with its address and,
// for function symbols, the entry RVA. Run against the ANALYZED DB (gbfr202fast) —
// the lean import has no RTTI names.
//
// Args: one or more substrings (each searched independently):
//   -postScript ListSymbols.java ResultEnableInput Death Sigil
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;

public class ListSymbols extends GhidraScript {
    long baseOff;
    long rva(Address a) { return a.getOffset() - baseOff; }

    @Override
    public void run() throws Exception {
        baseOff = currentProgram.getImageBase().getOffset();
        String[] needles = getScriptArgs();
        if (needles == null || needles.length == 0) { println("need substring arg(s)"); return; }
        for (String needle : needles) {
            String lo = needle.toLowerCase();
            println("=== ListSymbols: \"" + needle + "\" ===");
            SymbolIterator it = currentProgram.getSymbolTable().getAllSymbols(true);
            int shown = 0;
            while (it.hasNext()) {
                Symbol s = it.next();
                String name = s.getName(true);
                if (!name.toLowerCase().contains(lo)) continue;
                Function fn = currentProgram.getFunctionManager().getFunctionAt(s.getAddress());
                println("  0x" + Long.toHexString(rva(s.getAddress())) + "  " + name +
                        (fn != null ? "  [function]" : "  [" + s.getSymbolType() + "]"));
                if (++shown >= 40) { println("  ... more elided"); break; }
            }
            if (shown == 0) println("  (no matches)");
        }
        println("=== done ===");
    }
}

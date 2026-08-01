// Ghidra Java post-script: search the symbol table (incl. RTTI-derived class/vtable
// names) for a case-insensitive substring and print each match with its address and,
// for function symbols, the entry RVA. Run against the ANALYZED DB (gbfr202fast) —
// the lean import has no RTTI names.
//
// Args: one or more substrings (each searched independently). If the FIRST arg is
// numeric it sets the per-needle match cap (default 40):
//   -postScript ListSymbols.java ResultEnableInput Death Sigil
//   -postScript ListSymbols.java 2000 StatusBase
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
        int cap = 40;
        int firstNeedle = 0;
        if (needles.length > 1 && needles[0].matches("\\d+")) {
            cap = Integer.parseInt(needles[0]);
            firstNeedle = 1;
        }
        for (int n = firstNeedle; n < needles.length; n++) {
            String needle = needles[n];
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
                if (++shown >= cap) { println("  ... more elided"); break; }
            }
            if (shown == 0) println("  (no matches)");
        }
        println("=== done ===");
    }
}

// Ghidra Java post-script: list every reference TO the given address(es), with the
// referencing function's entry RVA. The bridge for "who touches this global/vtable/
// function" queries. Needs xrefs, so run against the ANALYZED DB (gbfr202fast).
//
// Args: one or more RVAs (hex, with or without 0x), e.g.:
//   -postScript XrefsTo.java 0x7c24a78 0x7c24980
//
// Output: one line per referencing site, deduped by containing function, with the
// per-function site count. Filter with: grep 'XrefsTo.java>'
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import java.util.LinkedHashMap;
import java.util.Map;

public class XrefsTo extends GhidraScript {
    long baseOff;
    long rva(Address a) { return a.getOffset() - baseOff; }

    @Override
    public void run() throws Exception {
        baseOff = currentProgram.getImageBase().getOffset();
        FunctionManager fm = currentProgram.getFunctionManager();
        String[] args = getScriptArgs();
        if (args == null || args.length == 0) { println("need RVA arg(s)"); return; }
        for (String s : args) {
            long r = Long.parseLong(s.replaceFirst("^0[xX]", ""), 16);
            Address target = currentProgram.getImageBase().add(r);
            println("=== XrefsTo 0x" + Long.toHexString(r) + " (addr " + target + ") ===");
            // fn entry rva -> [site count, first site rva]
            Map<Long, long[]> byFn = new LinkedHashMap<>();
            int loose = 0, total = 0;
            ReferenceIterator it = currentProgram.getReferenceManager().getReferencesTo(target);
            while (it.hasNext()) {
                Reference ref = it.next();
                Address from = ref.getFromAddress();
                total++;
                Function fn = fm.getFunctionContaining(from);
                if (fn == null) {
                    if (loose < 10) {
                        println("  ref from rva=0x" + Long.toHexString(rva(from)) +
                                " (no containing fn) type=" + ref.getReferenceType());
                    }
                    loose++;
                    continue;
                }
                long fe = rva(fn.getEntryPoint());
                long[] rec = byFn.get(fe);
                if (rec == null) byFn.put(fe, new long[]{1, rva(from)});
                else rec[0]++;
            }
            for (Map.Entry<Long, long[]> e : byFn.entrySet()) {
                Function fn = fm.getFunctionAt(currentProgram.getImageBase().add(e.getKey()));
                println("  fn entry=0x" + Long.toHexString(e.getKey()) +
                        "  " + (fn != null ? fn.getName() : "?") +
                        "  sites=" + e.getValue()[0] +
                        "  first=0x" + Long.toHexString(e.getValue()[1]));
            }
            println("  total refs=" + total + " in " + byFn.size() + " function(s), " +
                    loose + " outside functions");
        }
        println("=== done ===");
    }
}

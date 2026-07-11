// Ghidra Java post-script: find every occurrence of an ASCII substring anywhere in
// memory (all blocks, not just executable), walk back to the enclosing C-string start,
// and report code references to it with the referencing function's entry RVA. This is
// the string->function bridge for the ANALYZED DB (needs xrefs, so run against a
// fully-analyzed program like gbfr202fast).
//
// Args: the ASCII substring (all args are joined with spaces):
//   -postScript FindStringRefs.java "SP_charge_full"
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;

public class FindStringRefs extends GhidraScript {
    long baseOff;
    FunctionManager fm;
    long rva(Address a) { return a.getOffset() - baseOff; }

    String cstringAt(Address start, int max) {
        StringBuilder sb = new StringBuilder();
        try {
            for (int i = 0; i < max; i++) {
                int b = currentProgram.getMemory().getByte(start.add(i)) & 0xff;
                if (b == 0) break;
                sb.append(b >= 0x20 && b < 0x7f ? (char) b : '.');
            }
        } catch (Exception e) { /* stop */ }
        return sb.toString();
    }

    @Override
    public void run() throws Exception {
        baseOff = currentProgram.getImageBase().getOffset();
        fm = currentProgram.getFunctionManager();
        String[] a = getScriptArgs();
        if (a == null || a.length == 0) { println("need a substring arg"); return; }
        String needle = String.join(" ", a);
        byte[] pat = needle.getBytes("US-ASCII");
        println("=== FindStringRefs: \"" + needle + "\" ===");

        List<Address> hits = new ArrayList<>();
        for (MemoryBlock b : currentProgram.getMemory().getBlocks()) {
            if (!b.isInitialized()) continue;
            long size = b.getEnd().getOffset() - b.getStart().getOffset() + 1;
            if (size > Integer.MAX_VALUE) continue;
            byte[] buf = new byte[(int) size];
            try { currentProgram.getMemory().getBytes(b.getStart(), buf); } catch (Exception e) { continue; }
            for (int i = 0; i + pat.length <= buf.length; i++) {
                boolean ok = true;
                for (int j = 0; j < pat.length; j++) {
                    if (buf[i + j] != pat[j]) { ok = false; break; }
                }
                if (ok) hits.add(b.getStart().add(i));
            }
        }
        println("  " + hits.size() + " raw hit(s)");

        // Dedup by C-string start (walk back to the previous NUL), then report refs.
        LinkedHashSet<Long> seen = new LinkedHashSet<>();
        int shown = 0;
        for (Address h : hits) {
            Address start = h;
            try {
                for (int back = 0; back < 256; back++) {
                    Address p = start.subtract(1);
                    if ((currentProgram.getMemory().getByte(p) & 0xff) == 0) break;
                    start = p;
                }
            } catch (Exception e) { /* keep start */ }
            if (!seen.add(start.getOffset())) continue;
            println("  str rva=0x" + Long.toHexString(rva(start)) + "  \"" + cstringAt(start, 96) + "\"");
            ReferenceIterator it = currentProgram.getReferenceManager().getReferencesTo(start);
            int nref = 0;
            while (it.hasNext() && nref < 12) {
                Reference r = it.next();
                Address from = r.getFromAddress();
                Function fn = fm.getFunctionContaining(from);
                println("      ref from rva=0x" + Long.toHexString(rva(from)) +
                        (fn != null
                            ? "  in " + fn.getName() + " entry=0x" + Long.toHexString(rva(fn.getEntryPoint()))
                            : "  (no containing fn)"));
                nref++;
            }
            if (nref == 0) println("      (no direct refs — may be referenced via an offset table)");
            if (++shown >= 25) { println("  ... more strings elided"); break; }
        }
        println("=== done ===");
    }
}

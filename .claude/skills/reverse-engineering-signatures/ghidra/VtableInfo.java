// Ghidra Java post-script: given a vtable RVA, dump the virtual-function pointers it
// holds (each as a function entry RVA) AND report code references TO the vtable address
// (the constructor(s) that install it — i.e. where an instance is created). Run against
// the ANALYZED DB (gbfr202fast) so pointers/xrefs are resolved.
//
// Args: one or more vtable RVAs (hex, 0x-prefixed):
//   -postScript VtableInfo.java 0x613df90 0x6143c58
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;

public class VtableInfo extends GhidraScript {
    long baseOff;
    long rva(Address a) { return a.getOffset() - baseOff; }

    @Override
    public void run() throws Exception {
        baseOff = currentProgram.getImageBase().getOffset();
        String[] args = getScriptArgs();
        if (args == null || args.length == 0) { println("need vtable rva arg(s)"); return; }
        for (String a : args) {
            long r = Long.decode(a);
            Address vt = currentProgram.getImageBase().add(r);
            println("=== VtableInfo vtable rva=0x" + Long.toHexString(r) + " ===");

            // 1) Dump up to 40 virtual method slots as function entry RVAs.
            println("  -- virtual methods --");
            for (int i = 0; i < 40; i++) {
                Address slot = vt.add((long) i * 8);
                long ptr;
                try { ptr = currentProgram.getMemory().getLong(slot); }
                catch (Exception e) { break; }
                if (ptr == 0) continue;
                Address target;
                try { target = currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(ptr); }
                catch (Exception e) { break; }
                long targRva = ptr - baseOff;
                // Stop when the pointer leaves the image (end of vtable).
                if (targRva < 0 || targRva > 0x10000000L) break;
                Function fn = currentProgram.getFunctionManager().getFunctionContaining(target);
                String nm = (fn != null) ? (fn.getName() + " entry=0x" + Long.toHexString(rva(fn.getEntryPoint()))) : "(no fn)";
                println("    [" + i + "] slot_rva=0x" + Long.toHexString(rva(slot)) +
                        " -> 0x" + Long.toHexString(targRva) + "  " + nm);
            }

            // 2) Code xrefs TO the vtable address: the constructors / installers.
            println("  -- xrefs to vtable (constructors/installers) --");
            ReferenceIterator it = currentProgram.getReferenceManager().getReferencesTo(vt);
            int n = 0;
            while (it.hasNext() && n < 30) {
                Reference ref = it.next();
                Address from = ref.getFromAddress();
                Function fn = currentProgram.getFunctionManager().getFunctionContaining(from);
                println("    ref from rva=0x" + Long.toHexString(rva(from)) +
                        (fn != null ? "  in " + fn.getName() + " entry=0x" + Long.toHexString(rva(fn.getEntryPoint())) : "  (no containing fn)"));
                n++;
            }
            if (n == 0) println("    (no direct xrefs found)");
        }
        println("=== done ===");
    }
}

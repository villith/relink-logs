// Ghidra Java post-script: decompile the function CONTAINING each given RVA to C and print it.
// Requires an ANALYZED database (the gbfr202fast project) — the decompiler needs analysis to
// have run. Use against the fast DB with -process (no re-import).
//
// Usage: -postScript Decompile.java 0x3f1330 [0x477cdb0 ...]
// Filter output with: grep 'Decompile.java>'
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;

public class Decompile extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        long base = currentProgram.getImageBase().getOffset();

        DecompInterface dec = new DecompInterface();
        dec.openProgram(currentProgram);

        for (String a : args) {
            long rva;
            try {
                rva = Long.decode(a);
            } catch (NumberFormatException e) {
                println("Decompile: bad rva '" + a + "'");
                continue;
            }
            Address addr = currentProgram.getImageBase().add(rva);
            Function fn = getFunctionContaining(addr);
            if (fn == null) {
                println("Decompile: NO FUNCTION containing rva " + a);
                continue;
            }
            long entryRva = fn.getEntryPoint().getOffset() - base;
            println("=== Decompile rva " + a + " -> function '" + fn.getName()
                    + "' entry=0x" + Long.toHexString(entryRva)
                    + " params=" + fn.getParameterCount() + " ===");

            DecompileResults res = dec.decompileFunction(fn, 60, monitor);
            if (res == null || !res.decompileCompleted()) {
                println("Decompile: FAILED (" + (res == null ? "null" : res.getErrorMessage()) + ")");
                continue;
            }
            String c = res.getDecompiledFunction().getC();
            // Print line-by-line so the harness log captures it with the script tag.
            for (String line : c.split("\n")) {
                println(line);
            }
            println("=== end " + a + " ===");
        }
        dec.dispose();
    }
}

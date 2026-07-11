// Ghidra Java post-script: find the containing-function ENTRY for specific RVAs by
// disassembling a local window and letting Ghidra's boundary heuristics create the
// function, WITHOUT full-program analysis. Fast, targeted — we only need a couple
// function boundaries, not analysis of all ~100k functions.
//
// Fixes the crash class where a call-follow signature landed mid-function on a
// wrong-arity target: here we get the true entry of the function CONTAINING the
// anchor.
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.app.cmd.function.CreateFunctionCmd;

public class FindEntry extends GhidraScript {

    long baseOff;
    FunctionManager fm;

    long rva(Address a) { return a.getOffset() - baseOff; }
    Address atRva(long r) { return currentProgram.getImageBase().add(r); }

    void disasmWindow(long anchorRva, long back, long fwd) {
        long s = Math.max(0, anchorRva - back);
        Address start = atRva(s);
        Address end = atRva(anchorRva + fwd);
        DisassembleCommand cmd = new DisassembleCommand(new AddressSet(start, end), null, true);
        cmd.applyTo(currentProgram, monitor);
    }

    // Scan backward from anchor for a prologue that follows int3/ret/nop padding.
    long findPrologueBackward(long anchorRva, int maxBack) throws Exception {
        Address start = atRva(anchorRva - maxBack);
        byte[] buf = new byte[maxBack];
        currentProgram.getMemory().getBytes(start, buf);
        int[] b = new int[maxBack];
        for (int k = 0; k < maxBack; k++) b[k] = buf[k] & 0xff;
        long best = -1;
        for (int i = 2; i + 1 < maxBack; i++) {
            int prev = b[i - 1];
            if (prev == 0xcc || prev == 0xc3 || prev == 0x90) {
                int op = b[i];
                int op2 = b[i + 1];
                boolean pro =
                    (op == 0x40 && op2 == 0x55) ||
                    (op == 0x55) ||
                    (op == 0x53 || op == 0x56 || op == 0x57) ||
                    (op == 0x48 && op2 == 0x89) ||
                    (op == 0x48 && op2 == 0x83) ||
                    (op == 0x48 && op2 == 0x81) ||
                    (op == 0x4c && op2 == 0x8b);
                if (pro) {
                    long cand = anchorRva - maxBack + i;
                    if (cand <= anchorRva) best = cand; // nearest at/below anchor
                }
            }
        }
        return best;
    }

    String bytesHex(Address a, int n) {
        try {
            byte[] bb = new byte[n];
            currentProgram.getMemory().getBytes(a, bb);
            StringBuilder sb = new StringBuilder();
            for (byte x : bb) sb.append(String.format("%02x ", x & 0xff));
            return sb.toString().trim();
        } catch (Exception e) { return "<unreadable>"; }
    }

    void handle(String label, long anchorRva) throws Exception {
        println("");
        println("-- " + label + "  anchor rva=0x" + Long.toHexString(anchorRva));
        disasmWindow(anchorRva, 0x2500, 0x400);
        Address a = atRva(anchorRva);
        Function fn = fm.getFunctionContaining(a);
        if (fn == null) {
            long pr = findPrologueBackward(anchorRva, 0x3000);
            if (pr >= 0) {
                println("   no fn yet; backward prologue rva=0x" + Long.toHexString(pr) + " -> creating");
                new CreateFunctionCmd(atRva(pr)).applyTo(currentProgram, monitor);
                fn = fm.getFunctionContaining(a);
            }
        }
        if (fn == null) {
            long pr = findPrologueBackward(anchorRva, 0x3000);
            println("   RESULT: no containing function. backward-prologue guess rva=0x" +
                    (pr >= 0 ? Long.toHexString(pr) : "-1"));
            return;
        }
        Address e = fn.getEntryPoint();
        println("   RESULT: ENTRY rva=0x" + Long.toHexString(rva(e)) +
                "  params=" + fn.getParameterCount() +
                "  cc=" + fn.getCallingConventionName());
        println("           entry bytes: " + bytesHex(e, 24));
    }

    @Override
    public void run() throws Exception {
        baseOff = currentProgram.getImageBase().getOffset();
        fm = currentProgram.getFunctionManager();
        println("=== targeted entry finder ===  base=0x" + Long.toHexString(baseOff));

        // Anchor RVAs come from script args: one or more hex RVAs, each a byte
        // *inside* the target function (typically the site of a surviving fingerprint,
        // found with the sigscan harness). Pass with:
        //   -postScript FindEntry.java 0x3f13b5 0x63ecb0
        String[] a = getScriptArgs();
        if (a != null && a.length > 0) {
            for (String s : a) {
                long anchor = Long.parseLong(s.trim().replaceFirst("^0x", ""), 16);
                handle("anchor", anchor);
            }
        } else {
            // No args: run the known-good self-check (must resolve to itself) so a bare
            // run still proves the method works on this binary.
            handle("process_damage_CHECK", 0x1fbd440L);
        }
        println("");
        println("=== done ===");
    }
}

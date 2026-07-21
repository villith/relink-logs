// Ghidra Java post-script: find every indirect CALL through a vtable slot with the
// given displacement, e.g. `CALL qword ptr [RAX + 0x48]`. This is the "who calls
// virtual slot N" query that XrefsTo cannot answer — a virtual call has no reference
// to the callee, only to the vtable, so the only way to find the call sites is to
// scan the disassembly. Uses the listing (not raw bytes), so data that happens to
// contain the byte pattern is never reported.
//
// Args: one or more slot displacements in hex, e.g.:
//   -postScript FindVCallSlot.java 0x48
//
// Output: one line per call site with the containing function's entry RVA.
// Filter with: grep 'FindVCallSlot.java>'
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;

public class FindVCallSlot extends GhidraScript {
    long baseOff;
    long rva(Address a) { return a.getOffset() - baseOff; }

    @Override
    public void run() throws Exception {
        baseOff = currentProgram.getImageBase().getOffset();
        String[] args = getScriptArgs();
        if (args == null || args.length == 0) { println("need slot displacement arg(s)"); return; }
        for (String arg : args) {
            long disp = Long.parseLong(arg.trim().toLowerCase().replaceFirst("^0x", ""), 16);
            // Ghidra renders the displacement in the instruction text as `+ 0x48]`.
            String needle = "+ 0x" + Long.toHexString(disp) + "]";
            println("=== FindVCallSlot: slot displacement " + arg + " (matching \"" + needle + "\") ===");
            int hits = 0;
            InstructionIterator it = currentProgram.getListing().getInstructions(true);
            while (it.hasNext()) {
                Instruction ins = it.next();
                if (!ins.getMnemonicString().equalsIgnoreCase("CALL")) continue;
                String text = ins.toString();
                if (!text.contains("qword ptr [") || !text.contains(needle)) continue;
                Function fn = getFunctionContaining(ins.getAddress());
                // Trailing context: the mnemonics of the next few instructions, so a
                // caller can be recognised by what it DOES with the call's out-param
                // (e.g. a MOVSS/CVTTSS2SI read of a float field = a damage consumer).
                // Leading context: the previous few instructions identify how the
                // arguments were set up (e.g. a LEA RDX = an out-param call).
                StringBuilder prev = new StringBuilder();
                Instruction back = ins;
                for (int i = 0; i < 4 && back != null; i++) {
                    back = back.getPrevious();
                    if (back == null) break;
                    prev.insert(0, back.toString() + " | ");
                }
                StringBuilder next = new StringBuilder();
                Instruction cur = ins;
                for (int i = 0; i < 8 && cur != null; i++) {
                    cur = cur.getNext();
                    if (cur == null) break;
                    next.append(" | ").append(cur.toString());
                }
                println("  site rva=0x" + Long.toHexString(rva(ins.getAddress())) + "  " + text +
                        (fn != null
                            ? "  in " + fn.getName() + " entry=0x" + Long.toHexString(rva(fn.getEntryPoint()))
                            : "  (no containing fn)") +
                        "  prev: " + prev + "  next:" + next);
                hits++;
            }
            println("  total call sites: " + hits);
        }
        println("=== done ===");
    }
}

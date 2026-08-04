// Find every instruction whose rendered text contains a given substring
// (case-insensitive), with its containing function. THE query for "who touches
// struct field +0xNNNN" — a displacement inside a memory operand like
// `[RSI + 0x1b690]` is NOT a scalar operand, so ImmSites.java cannot see it.
//
//   -postScript FindOperandText.java <needle> [<needle> ...]
//
// Output per needle:
//   === FindOperandText <needle> ===
//   HIT|<site_rva>|<fn_entry>|<fn_name>|<instruction text>
//   === done <needle>, N hit(s) ===
// Scans the whole listing once per needle; a few minutes on the 118 MB exe.
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;

public class FindOperandText extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            println("usage: FindOperandText <needle> [<needle> ...]");
            return;
        }
        long base = currentProgram.getImageBase().getOffset();
        for (String rawNeedle : args) {
            String needle = rawNeedle.toLowerCase();
            println("=== FindOperandText " + rawNeedle + " ===");
            int shown = 0;
            InstructionIterator it = currentProgram.getListing().getInstructions(true);
            while (it.hasNext() && !monitor.isCancelled()) {
                Instruction ins = it.next();
                String t = ins.toString();
                if (!t.toLowerCase().contains(needle)) continue;
                Function fn = getFunctionContaining(ins.getAddress());
                println("HIT|0x" + Long.toHexString(ins.getAddress().getOffset() - base)
                        + "|" + (fn == null ? "0x0" : "0x" + Long.toHexString(
                                fn.getEntryPoint().getOffset() - base))
                        + "|" + (fn == null ? "(none)" : fn.getName())
                        + "|" + t);
                shown++;
            }
            println("=== done " + rawNeedle + ", " + shown + " hit(s) ===");
        }
    }
}

// Find every instruction whose scalar operand equals one of the given values,
// and report the containing function plus the instruction text. Used to locate
// where a "missing" cause constant (e.g. 1100) is loaded, when it never shows
// up at the known status-apply call sites.
//   -postScript ImmSites.java <value> [<value> ...]      (decimal or 0x...)
// Output: "IMM|value,rva,fn_entry,fn_name,instruction"
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.lang.OperandType;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.scalar.Scalar;
import java.util.HashSet;
import java.util.Set;

public class ImmSites extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 1) {
            println("usage: ImmSites <value> [<value> ...]");
            return;
        }
        Set<Long> wanted = new HashSet<>();
        for (String a : args) wanted.add(Long.decode(a));
        long base = currentProgram.getImageBase().getOffset();

        int hits = 0;
        InstructionIterator it = currentProgram.getListing().getInstructions(true);
        while (it.hasNext() && !monitor.isCancelled()) {
            Instruction ins = it.next();
            for (int op = 0; op < ins.getNumOperands(); op++) {
                if ((ins.getOperandType(op) & OperandType.SCALAR) == 0) continue;
                Scalar s = ins.getScalar(op);
                if (s == null || !wanted.contains(s.getUnsignedValue())) continue;
                Address a = ins.getAddress();
                Function fn = getFunctionContaining(a);
                println("IMM|" + s.getUnsignedValue() + ",0x" + Long.toHexString(a.getOffset() - base)
                        + "," + (fn == null ? "0x0" : "0x" + Long.toHexString(
                                fn.getEntryPoint().getOffset() - base))
                        + "," + (fn == null ? "(none)" : fn.getName())
                        + "," + ins.toString().replace(",", ";"));
                hits++;
                break;
            }
        }
        println("=== done, " + hits + " hit(s) ===");
    }
}

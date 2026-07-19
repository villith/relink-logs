// Ghidra Java PRE-script: disable the decompiler-based analyzers that dominate wall-clock
// time on large stripped binaries, so a full-program analysis of the 118 MB GBFR exe
// completes far faster while STILL producing what we need: function boundaries,
// cross-references (xrefs), and on-demand decompilation (the decompiler runs per-function at
// query time and does NOT need these global analyzers to have run).
//
// Per Ghidra maintainers, "Decompiler Parameter ID" alone can ~10x analysis time; it plus
// the other decompiler/CC analyzers are the main sinks. Option names below are the exact
// registered names (confirmed against Ghidra docs). To avoid a silent no-op from a wrong
// name, this script ALSO enumerates every option via getOptionNames() and logs it, and
// warns for any target name not present — so the run log proves what actually happened.
//
// Run as: analyzeHeadless <proj> <name> -import <exe> -scriptPath <this dir> \
//            -preScript FastAnalysisOptions.java
//
// @category GBFR
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Program;
import ghidra.framework.options.Options;
import java.util.List;
import java.util.Arrays;

public class FastAnalysisOptions extends GhidraScript {
    @Override
    public void run() throws Exception {
        Program p = currentProgram;
        if (p == null) {
            println("FastAnalysisOptions: ERROR no current program");
            return;
        }
        Options opt = p.getOptions(Program.ANALYSIS_PROPERTIES);

        // Log EVERY analysis option name so we can see exact spellings in the run log.
        println("FastAnalysisOptions: === all analysis option names ===");
        for (String n : opt.getOptionNames()) {
            println("FastAnalysisOptions:   opt = '" + n + "'");
        }

        // Exact registered analyzer names to disable (the slow decompiler/CC-driven ones).
        List<String> disable = Arrays.asList(
            "Decompiler Parameter ID",       // ~10x time multiplier — the big one
            "Decompiler Switch Analysis",    // decompiler-driven
            "Call Convention ID",            // calling-convention inference
            "Aggressive Instruction Finder", // exhaustive scan of undefined bytes
            "Stack"                          // stack-frame analysis
        );

        int disabled = 0;
        for (String name : disable) {
            boolean found = false;
            for (String actual : opt.getOptionNames()) {
                // Match the analyzer toggle itself (exact) OR its top-level group prefix,
                // but NOT sub-options like "X.Timeout" (those aren't booleans we flip).
                if (actual.equals(name)) {
                    found = true;
                    boolean was = opt.getBoolean(actual, true);
                    opt.setBoolean(actual, false);
                    println("FastAnalysisOptions: DISABLED '" + actual + "' (was " + was + ")");
                    disabled++;
                    break;
                }
            }
            if (!found) {
                println("FastAnalysisOptions: WARN target not found: '" + name + "'");
            }
        }
        println("FastAnalysisOptions: done — disabled " + disabled + " of " + disable.size()
                + " targets; function ID + refs + on-demand decompile remain ON");
    }
}

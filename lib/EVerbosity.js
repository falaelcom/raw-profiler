"use strict";

//	Enum: Enumerates all supported verbosity levels.
const EVerbosity =
{
	//	Field: Only profiling hit point's `text + prefix` is logged.
	Log: "log",
	//	Field: Will print tables with summary and info only for the current profiling hit key.
	Brief: "brief",
	//	Field: Will print full profiling stats for each profiling hit.
	Full: "full",
}

module.exports = EVerbosity;
module.exports.EVerbosity = module.exports;

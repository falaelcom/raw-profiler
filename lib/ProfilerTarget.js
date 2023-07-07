﻿"use strict";

const { MachineStats } = require("./MachineStats.js");
const { hrtimeToNs } = require("./Utility.js");

//	Class: `ProfilerTarget` - maintains the profiling state of a `(bucketKey, key)` pair.
//	Remarks: Profiling stats are collected and calculated per `(bucketKey, key)` pairs. Instances of this class are created on demand by the `Profiler` for every `(bucketKey, key)` pair
//		and are used to keep the respective state indefinitely.
//	See also: `Profiler`.
class ProfilerTarget
{
	//	Constructor: Creates a new instance of the `ProfilerTarget` class.
	//	Parameter: `bucketKey: string` - a key for grouping and configuration management of profiling data at log-file level; a single profiling bucket usually corresponds to a single
	//		profiling hit point in the code, for Ex. `"CRUD"`, `"REST"`, `"RPC"`, `"VerySpecificSuspiciousLoop"`.
	//	Parameter: `key: string` - a key for grouping of profiling data at statistics level within a bucket; multiple profiling hits (i.e. `Profiler.begin`/`Profiler.end` pairs) for the same
	//		`(bucketKey, key)` pair are aggregated and analysed statistically and produce stats such as minimum, average, maximum and total execution time.
	constructor(bucketKey, key)
	{
		this.bucketKey = bucketKey || "";
		this.key = key;
		this.stats =
		{
			hitCount: 0,
			count: 0,
			minNs: Number.MAX_SAFE_INTEGER,         //  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/MAX_SAFE_INTEGER
			maxNs: 0,
			maxDateTime: new Date(),
			avgNs: 0,
			totalMs: 0,
			avgCpu: 0,
			minAvgOsCpu: 100,      //   based on MachineStats.osResourceStats 1 minute stats, taken at the end of the hit
			maxAvgOsCpu: 0,        //   based on MachineStats.osResourceStats 1 minute stats, taken at the end of the hit
			avgAvgOsCpu: 0,        //   based on MachineStats.osResourceStats 1 minute stats, taken at the end of the hit
		};
	}

	//	Function: `getStats()` - returns a new object containing the current stats for this `ProfilerTarget`.
	//	Returns:
	//	```
	//	{
	//		bucketKey: string,			//	a key for grouping and configuration management of profiling data at log-file level
	//		key: string,				//	a key for grouping of profiling data at statistics level within a bucket
	//		count: uint,				//	the number of finished profiling hits handled by this `ProfilerTarget`
	//		discrepancy: integer,		//	the number of open hits within this `ProfilingTatget` at the moment of the `getStats()` function call; values other than 0 indicate incidents of a profiling hit point that has been hit, but never ended (the corresponding `__pfend` has not been calld yet); it's normal to see such indications from time to time appear and disappear; a problem could be recognized, if such indications last for longer and the `discrepancy` value is steadily increasing
	//		minNs: uint,				//	the shortest execution time on record for the this `ProfilingTatget`, in nanoseconds
	//		minMs: uint,				//	the shortest execution time on record for the this `ProfilingTatget`, in milliseconds
	//		maxNs: uint,				//	the longest execution time on record for the this `ProfilingTatget`, in nanoseconds
	//		maxMs: uint,				//	the longest execution time on record for the this `ProfilingTatget`, in milliseconds
	//		maxDateTime: Date,			//	the date/time when the longest execution time was recorded
	//		avgNs: uint,				//	the average execution time for the this `ProfilingTatget`, in nanoseconds
	//		avgMs: uint,				//	the average execution time for the this `ProfilingTatget`, in milliseconds
	//		totalMs: uint,				//	the total execution time for all profiling hits handleded the this `ProfilingTatget`, in milliseconds
	//		totalSec: uint,				//	the total execution time for all profiling hits handleded the this `ProfilingTatget`, in seconds
	//		avgCpu: uint,				//	the load of the OS CPU during the hit duration; if multiple CPUs are reported by the OS, the highest value is taken; it is normal for this value to be close to 100% - this means that during the profiling hit the application's main thread did not wait
	//		minAvgOsCpu: uint,			//	the minimum OS CPU load, measured for the last 1 minute at the end of a profiling hit for the specified key (this value has no direct relation to the `CPU%` value); indicative for the overall os performance at the time of the profiling hit
	//		avgAvgOsCpu: uint,			//	the average OS CPU load, measured for the last 1 minute since the profiling has started for the specified key (this value has no direct relation to the `CPU%` value); indicative for the overall os performance at the time of the profiling hit
	//		maxAvgOsCpu: uint,			//	the maximum OS CPU load, measured for the last 1 minute at the end of a profiling hit for the specified key (this value has no direct relation to the `CPU%` value); indicative for the overall os performance at the time of the profiling hit
	//	}
	//	```
	//	Remarks: The object returned by this function contains the profiling data logged in tabular format on profiling hit and represents the main product of the profiling effort.
	getStats()
	{
		const result = {};

		result.bucketKey = this.bucketKey;
		result.key = this.key;

		result.count = this.stats.count;
		result.discrepancy = this.stats.hitCount - this.stats.count;

		result.minNs = this.stats.minNs;
		result.minMs = Math.round(this.stats.minNs / 1000000);

		result.maxNs = this.stats.maxNs;
		result.maxMs = Math.round(this.stats.maxNs / 1000000);
		result.maxDateTime = this.stats.maxDateTime;

		result.avgNs = this.stats.avgNs;
		result.avgMs = Math.round(this.stats.avgNs / 1000000);

		result.totalMs = this.stats.totalMs;
		result.totalSec = Math.round(this.stats.totalMs / 1000);

		result.avgCpu = Math.round(this.stats.avgCpu);
		result.minAvgOsCpu = Math.round(this.stats.minAvgOsCpu);
		result.avgAvgOsCpu = Math.round(this.stats.avgAvgOsCpu);
		result.maxAvgOsCpu = Math.round(this.stats.maxAvgOsCpu);

		return result;
	}

	//	Function: `hit(title: string, hitCount: uint, openHitsCount: uint): object` - Creates and returns an object representing a new profiling hit.
	//	Parameter: `title: string` - required; a text used as a title for profiling stats tables with `EVerbosity.Brief` and `EVerbosity.Full` and as a
	//		logging line with `EVerbosity.Log`; the `ProfilerTarget.finish` call can append a postfix text to this text.
	//	Parameter: `hitCount: uint` - a global serial number of the profiling hit at the beginning of the profiling hit; it provides the ability to 1) unambiguasly determine profiling hit
	//		events global precedence and b) report the number of other profiling hits detected during the execution time of this profiling hit.
	//	Parameter: `openHitsCount: uint` - the number of profling hits that have begun but have not ended at the beginning of the profiling hit.
	//	Returns: An object representing current state required for the measurements for hit profiling, with the following schema:
	//	```
	//	{
	//		index: uint,												//	a global serial number of the profiling hit; it provides the ability to 1) unambiguasly determine profiling hit events global precedence and b) report the number of other profiling hits detected during the execution time of this profiling hit
	//		localIndex: integer,										//	a serial number of the profiling hit specific for the profiling `key`; it provides the ability to 1) unambiguasly determine profiling hit events precedence within of the scope of a sinle profiling `key` and b) report the number of other profiling hits with the same key detected during the execution time of this profiling hit
	//		openHitsCount: uint,										//	the number of profling hits that have begun but have not ended at the beginning of this profiling hit
	//		bucketKey: string,											//	a key for grouping and configuration management of profiling data at log-file level; a single profiling bucket usually corresponds to a single profiling hit point in the code, for Ex. `"CRUD"`, `"REST"`, `"RPC"`, `"VerySpecificSuspiciousLoop"`
	//		key: string,												//	a key for grouping of profiling data at statistics level within a bucket; multiple profiling hits (i.e. `Profiler.begin`/`Profiler.end` pairs) for the same `(bucketKey, key)` pair are aggregated and analysed statistically and produce stats such as minimum, average, maximum and total execution time
	//		title: title,												//	a text used as a title for profiling stats tables with `EVerbosity.Brief` and `EVerbosity.Full` and as a logging line with `EVerbosity.Log`; the `ProfilerTarget.finish` call can append a postfix text to this text
	//		time: Date,													//	a date/time object representing the time the profiling hit started
	//		hrtime: [seconds, nanoseconds],								//	a value as returned by `process.hrtime()`
	//		currentHitStats: null,										//	will be initialized at the end of the profiling hit; see `ProfilerTarget.finish` docs for reference
	//		machineStatsSnapshot: object,								//	an object containing a snapshot of the system usage stats at the beginning of the profiling hit; the return value of a `MachineStats.getSnapshot()` call; see `MachineStats.getSnapshot()` docs for reference
	//		currentMachineStats: null,									//	will be initialized at the end of the profiling hit; see `ProfilerTarget.finish` docs for reference
	//	}
	//	```
	hit(title, hitCount, openHitsCount)
	{
		++this.stats.hitCount;

		return {
			index: hitCount,
			localIndex: this.stats.hitCount - 1,
			openHitsCount: openHitsCount,
			bucketKey: this.bucketKey,
			key: this.key,
			title: title,
			time: new Date(),
			hrtime: process.hrtime(),
			currentHitStats: null,
			machineStatsSnapshot: MachineStats.getSnapshot(),
			currentMachineStats: null,
		};
	}

	//	Function: `finish(hit: object, postfix: string, hitCount: uint, openHitsCount: uint): void` - calculates profiling data and finalizes a profiling `hit`.
	//	Parameter: `hit: object` - required; the result of the corresponding `ProfilerTarget.hit` call.
	//	Parameter: `postfix: string` - optional; appended to the `text` from the corresponding `ProfilerTarget.hit` call.
	//	Parameter: `hitCount: uint` - a global serial number of the profiling hit at the end of the profiling hit; it provides the ability to 1) unambiguasly determine profiling hit
	//		events global precedence and b) report the number of other profiling hits detected during the execution time of this profiling hit.
	//	Parameter: `openHitsCount: uint` - the number of profling hits that have begun but have not ended at the end of the profiling hit.
	//	Remarks: Modifies the `hit` object. Assigns values to `hit.currentHitStats` and `hit.currentMachineStats`. Modifies `hit.title` by appending `prefix`.
	finish(hit, postfix, hitCount, openHitsCount)
	{
		if (!hit || !hit.hrtime || hit.hrtime.length != 2)
		{
			this.onError(39991, `Argument is invalid: "hit", ${String(hit)}`, new TypeError());
			return;
		}

		const hrtimespan = process.hrtime(hit.hrtime);
		const ns = hrtimeToNs(hrtimespan);

		++this.stats.count;

		this.stats.minNs = Math.min(ns, this.stats.minNs);
		this.stats.maxNs = Math.max(ns, this.stats.maxNs);
		if (this.stats.maxNs == ns)
		{
			this.stats.maxDateTime = hit.time;
		}

		//  https://ubuntuincident.wordpress.com/2012/04/25/calculating-the-average-incrementally/
		this.stats.avgNs = this.stats.avgNs + (ns - this.stats.avgNs) / this.stats.count;

		this.stats.totalMs += Math.round(ns / 1000000);

		//  machine stats
		const currentSnapshot = MachineStats.getSnapshot(hit.machineStatsSnapshot.hrtime);
		hit.currentMachineStats = MachineStats.getMachineStats(currentSnapshot, hit.machineStatsSnapshot);

		//  https://ubuntuincident.wordpress.com/2012/04/25/calculating-the-average-incrementally/
		this.stats.avgCpu = this.stats.avgCpu + (hit.currentMachineStats.osMaxCpu - this.stats.avgCpu) / this.stats.count;

		this.stats.minAvgOsCpu = Math.min(hit.currentMachineStats.osAvgLoad_end, this.stats.minAvgOsCpu);
		this.stats.maxAvgOsCpu = Math.max(hit.currentMachineStats.osAvgLoad_end, this.stats.maxAvgOsCpu);
		//  https://ubuntuincident.wordpress.com/2012/04/25/calculating-the-average-incrementally/
		this.stats.avgAvgOsCpu = this.stats.avgAvgOsCpu + (hit.currentMachineStats.osAvgLoad_end - this.stats.avgAvgOsCpu) / this.stats.count;

		hit.currentHitStats =
		{
			diffIndex: hitCount - hit.index,
			hitIndex: hit.index,
			doneIndex: hitCount,
			diffLocalIndex: this.stats.count - 1 - hit.localIndex,
			hitLocalIndex: hit.localIndex,
			doneLocalIndex: this.stats.count - 1,
			diffOpenHitsCount: openHitsCount - hit.openHitsCount,
			hitOpenHitsCount: hit.openHitsCount,
			doneOpenHitsCount: openHitsCount,

			hrtimespan: hrtimespan,
			ns: ns,
			ms: Math.round(ns / 1000000),
			avgCpu: hit.currentMachineStats.osMaxCpu,
		};

		if (postfix)
		{
			hit.title += postfix;
		}
	}
}

module.exports = ProfilerTarget;
module.exports.ProfilerTarget = module.exports;
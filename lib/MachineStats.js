"use strict";

const os = require("os");

//	Class: Provides static utility functions for collecting and calculating performance metrics (CPU and RAM loads) for the current process and for the OS.
class MachineStats
{
	//	Function: `getSnapshot(hrtime: [seconds, nanoseconds]): object` - Builds an object containing a snapshot of the current system usage stats.
	//	Parameter: `hrtime: [seconds, nanoseconds]` - optional; if missing, will force the function to query and record the current `hrtime` (high resolution time) as provided by `process.hrtime()`;
	//		otherwise will force the function to record the time interval between now and the provided `hrtime` parameter in hrtime (high resolution time) format (`[seconds, nanoseconds]`).
	//	Returns:
	//	```
	//	{
	//		hrtime: [seconds, nanoseconds],								//	a value returned by either by `process.hrtime()` or `process.hrtime(hrtime)`
	//
	//		psUptime: number,											//	a floatig point value in seconds as returned by `process.uptime()`
	//		psCpuUsage: { system: number, user: number },				//	an object indicating in microseconds the amount of CPU time spent in user and system code, respectively, as returned by `process.cpuUsage()`; if `process.cpuUsage()` is not supported by the nodejs version, `{ system: 0, user: 0 }` is used
	//		psMemUsage:													//	an object indicating current process memory usage in bytes as returned by `process.memoryUsage()`
	//		{
	//			rss: uint,												//	Resident Set Size - the amount of space occupied in the main memory device (that is a subset of the total allocated memory) for the process, which includes the heap, code segment and stack.
	//			heapTotal: uint,										//	The total size of the allocated heap.
	//			heapUsed: uint,											//	The actual memory used during the execution of the process.
	//			external: uint											//	The memory used by "external" resources tied to the Node.js process, such as the V8 engine and other internal Node.js operations.
	//		},
	//
	//		osUptime: number,											//	a floatig point value in seconds as returned by `os.uptime()`
	//		osAvgLoad: number,											//	a 1-minute average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs
	//		osAvgLoad5min: number,										//	a 5-minute average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs
	//		osAvgLoad15min: number,										//	a 15-minute average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs
	//		osCpusUsage: [ { busy: uint, idle: uint }, ... ],			//	the current OS CPU usage data in milliseconds as returned by `MachineStats.getOsCpusUsage()`
	//		osMemUsage:													//	an object indicating current memory usage in bytes as returned by `process.memoryUsage()`
	//		{
	//			free: uint,												//	free system meory in bytes as returned by `os.freemem()`
	//			total: uint,											//	total system meory in bytes as returned by `os.totalmem()`
	//		}
	//	}
	//	```
	static getSnapshot(hrtime = void 0)
	{
		return {
			hrtime: process.hrtime(hrtime),	//	if `hrtime === void 0`, the current time is returned by `process.hrtime(hrtime)`

			psUptime: MachineStats.osResourceStats.psUptime,
			psCpuUsage: MachineStats.osResourceStats.psCpuUsage,
			psMemUsage: MachineStats.osResourceStats.psMemUsage,

			osUptime: MachineStats.osResourceStats.osUptime,
			osAvgLoad: MachineStats.osResourceStats.avgCpu1min,
			osAvgLoad5min: MachineStats.osResourceStats.avgCpu5min,
			osAvgLoad15min: MachineStats.osResourceStats.avgCpu15min,
			osCpusUsage: MachineStats.getOsCpusUsage(),
			osMemUsage:
			{
				free: os.freemem(),
				total: os.totalmem(),
			},
		};
	}

	//	Function: `getMachineStats(currentSnapshot: object, prevSnapshot: object): object` - builds an object containing miscellaneous CPU and RAM usage statistics and deltas measured
	//		during operation between two points of time; includes several non-delta values, such as `osUptime`.
	//	Returns:
	//	```
	//	{
	//		timeNs: [seconds, nanoseconds],								//	execution time elapsed between `prevSnapshot` and `currentSnapshot`, as returned by `process.hrtime()`
	//		timeMs: uint,												//	execution time elapsed between `prevSnapshot` and `currentSnapshot` rounded, in milliseconds
	//
	//		psUptime: number,											//	a floatig point value in seconds as returned by `process.uptime()`
	//		psCpuUsage: uint,											//	percentage value indicating the average combined kernel and user (application) CPU load level between `prevSnapshot` and `currentSnapshot`
	//		psCpuUsage_kernel: uint,									//	percentage value indicating the average kernel CPU load level between `prevSnapshot` and `currentSnapshot`
	//		psCpuUsage_application: uint,								//	percentage value indicating the average user (application) CPU load level between `prevSnapshot` and `currentSnapshot`
	//		psMemUsage_begin: uint,										//	percentage value indicating the user (application) RAM load level (used/total) at the time of `prevSnapshot` (the beginning of the measurement interval)
	//		psMemUsage_end: uint,										//	percentage value indicating the user (application) RAM load level (used/total) at the time of `currentSnapshot` (the end of the measurement interval)
	//		psMemUsage_delta: uint,										//	percentage value indicating the user (application) RAM load level change (used/total) between `prevSnapshot` and `currentSnapshot`
	//
	//		osUptime: number,											//	a floatig point value in seconds as returned by `os.uptime()`
	//		osAvgLoad_begin: number,									//	a 1-minute average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs at the time of `prevSnapshot` (the beginning of the measurement interval)
	//		osAvgLoad_end: number,										//	a 1-minute average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs at the time of `currentSnapshot` (the end of the measurement interval)
	//		osAvgLoad5min_begin: number,								//	a 5-minute average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs at the time of `prevSnapshot` (the beginning of the measurement interval)
	//		osAvgLoad5min_end: number,									//	a 5-minute average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs at the time of `currentSnapshot` (the end of the measurement interval)
	//		osAvgLoad15min_begin: number,								//	a 15-minute average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs at the time of `prevSnapshot` (the beginning of the measurement interval)
	//		osAvgLoad15min_end: number,									//	a 15-minute average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs at the time of `currentSnapshot` (the end of the measurement interval)
	//		osCpusUsage: [ ratio: uint, ... ],							//	average OS CPU usage data per CPU in percents calculated as 100% - idle time divided by busy time as observed between `prevSnapshot` and `currentSnapshot`
	//		osMaxCpu: uint,												//	the largest value from `osCpusUsage`
	//		osMemUsage_begin:											//	percentage value indicating the kernel (os) RAM load level (used/total) at the time of `prevSnapshot` (the beginning of the measurement interval)
	//		osMemUsage_end:												//	percentage value indicating the kernel (os) RAM load level (used/total) at the time of `currentSnapshot` (the end of the measurement interval)
	//		psMemUsage_delta: uint,										//	percentage value indicating the kernel (os) RAM load level change (used/total) between `prevSnapshot` and `currentSnapshot`
	//	}
	//	```
	static getMachineStats(currentSnapshot, prevSnapshot)
	{
		const result =
		{
			timeNs: currentSnapshot.hrtime,
			timeMs: currentSnapshot.hrtime[0] + Math.round(currentSnapshot.hrtime[1] / 1000000),

			psUptime: currentSnapshot.psUptime,
			psCpuUsage: 0,
			psCpuUsage_kernel: 0,
			psCpuUsage_application: 0,
			psMemUsage_begin: 0,
			psMemUsage_end: 0,
			psMemUsage_delta: 0,

			osUptime: currentSnapshot.osUptime,
			osAvgLoad_begin: prevSnapshot.osAvgLoad,
			osAvgLoad_end: currentSnapshot.osAvgLoad,
			osAvgLoad5min_begin: prevSnapshot.osAvgLoad5min,
			osAvgLoad5min_end: currentSnapshot.osAvgLoad5min,
			osAvgLoad15min_begin: prevSnapshot.osAvgLoad15min,
			osAvgLoad15min_end: currentSnapshot.osAvgLoad15min,
			osCpusUsage: [],
			osMaxCpu: 0,
			osMemUsage_begin: 0,
			osMemUsage_end: 0,
			osMemUsage_delta: 0,
		};

		//  ps cpu usage
		const time_micros = Math.round(currentSnapshot.hrtime / 1000);
		const deltaKernelBusy_micros = currentSnapshot.psCpuUsage.system - prevSnapshot.psCpuUsage.system;
		result.psCpuUsage_kernel = Math.floor(100 * deltaKernelBusy_micros / time_micros);
		const deltaUserBusy_micros = currentSnapshot.psCpuUsage.user - prevSnapshot.psCpuUsage.user;
		result.psCpuUsage_application = Math.floor(100 * deltaUserBusy_micros / time_micros);
		result.psCpuUsage = result.psCpuUsage_kernel + result.psCpuUsage_application;

		//  ps mem usage
		result.psMemUsage_begin = Math.floor(100 * currentSnapshot.psMemUsage.heapUsed / currentSnapshot.psMemUsage.heapTotal);
		result.psMemUsage_end = Math.floor(100 * prevSnapshot.psMemUsage.heapUsed / prevSnapshot.psMemUsage.heapTotal);
		result.psMemUsage_delta = result.psMemUsage_end - result.psMemUsage_begin;

		//  os cpu usage
		for (let length = prevSnapshot.osCpusUsage.length, i = 0; i < length; ++i)
		{
			const item1 = prevSnapshot.osCpusUsage[i];
			const item2 = currentSnapshot.osCpusUsage[i];

			const idleDifference = item2.idle - item1.idle;
			const busyDifference = item2.busy - item1.busy;

			const resultItem = 100 - Math.floor(100 * idleDifference / busyDifference);
			result.osCpusUsage.push(resultItem);

			result.osMaxCpu = Math.max(result.osMaxCpu, resultItem);
		}

		//  os mem usage
		result.osMemUsage_begin = 100 - Math.floor(100 * currentSnapshot.osMemUsage.free / currentSnapshot.osMemUsage.total);
		result.osMemUsage_end = 100 - Math.floor(100 * prevSnapshot.osMemUsage.free / prevSnapshot.osMemUsage.total);
		result.osMemUsage_delta = result.osMemUsage_end - result.osMemUsage_begin;

		return result;
	}

	//	Function: `getOsCpusUsage(): Array` - queries nodejs for CPU usage data at OS level as returned by `os.cpus()` and returns a transformed result in milliseconds.
	//	Returns: a list of usage stats per CPU (array length reflects the number of installed CPUs) in the form:
	//	```
	//		[
	//			{
	//				busy: uint,		//	the sum of all types of busy time time, measured by `os.cpus()`, in milliseconds, e.g. `user` + `nice` + `sys` + `irq`
	//				idle: uint,		//	the amount of time during which the CPU was idle, in milliseconds
	//			},...
	//		]
	//	```
	static getOsCpusUsage()
	{
		const result = [];
		const osCpus = os.cpus();

		for (let length = osCpus.length, i = 0; i < length; ++i)
		{
			const cpu = osCpus[i];
			const item =
			{
				busy: 0,
				idle: cpu.times.idle,
			};
			for (const type in cpu.times)
			{
				item.busy += cpu.times[type];
			}
			result.push(item);
		}

		return result;
	}

	//	Field: A collection of current CPU and RAM monitoring values.
	//	Schema:
	//	```
	//	{
	//		avgCpu10sec: 0,												//	a 10-seconds average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs
	//		avgCpu1min: 0,												//	a 1-minute average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs
	//		avgCpu5min: 0,												//	a 5-minute average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs
	//		avgCpu15min: 0,												//	a 15-minute average of CPU usage in percents with 2 decimal digits calculated as 100% - idle time divided by busy time, averaged between all CPUs
	//
	//		psCpuUsage: { system: number, user: number },				//	an object indicating in microseconds the amount of CPU time spent in user and system code, respectively, as returned by `process.cpuUsage()`; if `process.cpuUsage()` is not supported by the nodejs version, `{ system: 0, user: 0 }` is used
	//		psMemUsage:													//	an object indicating current process memory usage in bytes as returned by `process.memoryUsage()`
	//		{
	//			rss: uint,												//	Resident Set Size - the amount of space occupied in the main memory device (that is a subset of the total allocated memory) for the process, which includes the heap, code segment and stack.
	//			heapTotal: uint,										//	The total size of the allocated heap.
	//			heapUsed: uint,											//	The actual memory used during the execution of the process.
	//			external: uint											//	The memory used by "external" resources tied to the Node.js process, such as the V8 engine and other internal Node.js operations.
	//		},
	//
	//		psUptime: number,											//	a floatig point value in seconds as returned by `process.uptime()`
	//		osUptime: number,											//	a floatig point value in seconds as returned by `os.uptime()`
	//	}
	//	```
	//	Remarks: The values stored in this object are updated every 5 seconds by a timer started via a `MachineStats.startCpuMonitoring()` call.
	static osResourceStats =
	{
		avgCpu10sec: 0,
		avgCpu1min: 0,
		avgCpu5min: 0,
		avgCpu15min: 0,

		psCpuUsage: process.cpuUsage ? process.cpuUsage() : { system: 0, user: 0 },
		psMemUsage: process.memoryUsage(),

		psUptime: process.uptime(),
		osUptime: os.uptime(),
	}

	//	Function: `startCpuMonitoring(): void` - Starts a timer and updates the values stored in `MachineStats.osResourceStats` (a collection of current CPU and RAM monitoring values) every 5 seconds.
	//	Remarks: Silently ignores repeated calls.
	static startCpuMonitoring()
	{
		if (MachineStats.cpuMonitoringTimerId !== void 0) return;

		const getAvgUsage = function (snapshot1, snapshot2)
		{
			let total = 0;
			for (let length = snapshot1.length, i = 0; i < length; ++i)
			{
				const item1 = snapshot1[i];
				const item2 = snapshot2[i];

				const idleDifference = item2.idle - item1.idle;
				const busyDifference = item2.busy - item1.busy;

				total += 100 - Math.floor(100 * idleDifference / busyDifference);
			}
			return (Math.floor(total * 100 / snapshot1.length) / 100);
		}

		const maxTimeWindowMs = 15 * 60 * 1000;       //  15 min
		const resolutionMs = 5 * 1000;                //   5 sec
		const snapshotHistorySize = Math.ceil(maxTimeWindowMs / resolutionMs) + 1;
		const snapshotHistory = Array(snapshotHistorySize).fill(null);
		const snapshotHistoryLastIndex = snapshotHistory.length - 1;
		let snapshotHistoryFirstIndex = snapshotHistoryLastIndex;

		MachineStats.cpuMonitoringTimerId = setInterval(function ()
		{
			const snapshot = MachineStats.getOsCpusUsage();
			snapshotHistory.push(snapshot);
			snapshotHistory.shift();

			if (snapshotHistoryFirstIndex != snapshotHistoryLastIndex)
			{
				let timeWindowMs, snapshotHistoryIndex;
				timeWindowMs = 10 * 1000; snapshotHistoryIndex = Math.max(snapshotHistoryLastIndex - Math.ceil(timeWindowMs / resolutionMs), snapshotHistoryFirstIndex); const lastSnapshot_10sec = snapshotHistory[snapshotHistoryIndex];
				timeWindowMs = 60 * 1000; snapshotHistoryIndex = Math.max(snapshotHistoryLastIndex - Math.ceil(timeWindowMs / resolutionMs), snapshotHistoryFirstIndex); const lastSnapshot_1min = snapshotHistory[snapshotHistoryIndex];
				timeWindowMs = 5 * 60 * 1000; snapshotHistoryIndex = Math.max(snapshotHistoryLastIndex - Math.ceil(timeWindowMs / resolutionMs), snapshotHistoryFirstIndex); const lastSnapshot_5min = snapshotHistory[snapshotHistoryIndex];
				timeWindowMs = 15 * 60 * 1000; snapshotHistoryIndex = Math.max(snapshotHistoryLastIndex - Math.ceil(timeWindowMs / resolutionMs), snapshotHistoryFirstIndex); const lastSnapshot_15min = snapshotHistory[snapshotHistoryIndex];

				MachineStats.osResourceStats.avgCpu10sec = lastSnapshot_10sec ? getAvgUsage(lastSnapshot_10sec, snapshot) : 0;
				MachineStats.osResourceStats.avgCpu1min = lastSnapshot_1min ? getAvgUsage(lastSnapshot_1min, snapshot) : 0;
				MachineStats.osResourceStats.avgCpu5min = lastSnapshot_5min ? getAvgUsage(lastSnapshot_5min, snapshot) : 0;
				MachineStats.osResourceStats.avgCpu15min = lastSnapshot_15min ? getAvgUsage(lastSnapshot_15min, snapshot) : 0;
			}

			//keep this commented code for debugging
			//console.log(911, "10 sec", MachineStats.osResourceStats.avgCpu10sec + "%");
			//console.log(911, "1 min", MachineStats.osResourceStats.avgCpu1min + "%");
			//console.log(911, "5 min", MachineStats.osResourceStats.avgCpu5min + "%");
			//console.log(911, "15 min", MachineStats.osResourceStats.avgCpu15min + "%");

			MachineStats.osResourceStats.psUptime = process.uptime();
			MachineStats.osResourceStats.osUptime = os.uptime();
			MachineStats.osResourceStats.psCpuUsage = process.cpuUsage ? process.cpuUsage() : { system: 0, user: 0 };
			MachineStats.osResourceStats.psMemUsage = process.memoryUsage();

			if (snapshotHistoryFirstIndex > 0) --snapshotHistoryFirstIndex;
		}, resolutionMs);
	}
}

module.exports = MachineStats;
module.exports.MachineStats = module.exports;

"use strict";

//	Class: A collection of utility functions used throught the `raw-profiler` codebase.
//	Usage: `const { rep, rpad, lpad, erpad, elpad, fdate, fduration, hrtimeToNs, nsToHrtime } = require("./lib/Utility.js");`.
class Utility
{
	//#region Utilities: hrtime
	//	Function: `hrtimeToNs(hrtime: [seconds, nanoseconds]): uint` - Converts high-resolution timer data to nanoseconds.
	//	Parameter: `hrtime: [seconds, nanoseconds]` - high resolution time the as provided by `process.hrtime()`
	//	Returns: The value in `hrtime` as nanoseconds.
	static hrtimeToNs(hrtime)
	{
		return hrtime[0] * 1000000000 + hrtime[1];
	}

	//	Function: `hrtimeToMs(hrtime: [seconds, nanoseconds]): uint` - Converts high-resolution timer data to milliseconds.
	//	Parameter: `hrtime: [seconds, nanoseconds]` - high resolution time the as provided by `process.hrtime()`
	//	Returns: The value in `hrtime` as milliseconds.
	static hrtimeToMs(hrtime)
	{
		return hrtime[0] * 1000 + Math.round(hrtime[1] / 1000000);
	}

	//	Function: `hrtimeToMicros(hrtime: [seconds, nanoseconds]): uint` - Converts high-resolution timer data to milliseconds.
	//	Parameter: `hrtime: [seconds, nanoseconds]` - high resolution time the as provided by `process.hrtime()`
	//	Returns: The value in `hrtime` as milliseconds.
	static hrtimeToMicros(hrtime)
	{
		return hrtime[0] * 1e6 + Math.round(hrtime[1] / 1000);
	}

	//	Function: `nsToHrtime(ns: uint): [seconds, nanoseconds]` - Converts nanoseconds to high-resolution timer data as provided by `process.hrtime()`
	//	Parameter: `ns: uint` - timespan in nanoseconds.
	//	Returns: The value of `ns` as high-resolution timer data as provided by `process.hrtime()`
	//	Remarks: High-resolution timer data is returned by `process.hrtime()`.
	static nsToHrtime(ns)
	{
		const seconds = Math.floor(ns / 1000000000);
		const nanoseconds = ns - seconds * 1000000000;
		return [seconds, nanoseconds];
	}
	//#endregion

	//#region Utilities: text formatting
	//	Function: `rep(count: uint, character: string): string` - Repeat a character `count` times and return the resulting string.
	//	Parameter: `count: uint` - the number of times to repeat the character.
	//	Parameter: `character: string` - the character to repeat.
	//	Returns: a string contianing `coutn` repetittions of `character`.
	//	Remarks: Actually, `character` might be a string longer than 1 characters, and this function will work as expected.
	static rep(count, character)
	{
		return new Array(count + 1).join(character);
	}

	//	Function: `rpad(text: string, count: uint, character: string): string` - Right-pad the given `text` with `character` to ensure a total of `count` characters in the resulting string.
	//	Parameter: `text: string` - the input string.
	//	Parameter: `count: uint` - the minimum number of characters in the resulting string.
	//	Parameter: `character: string` - the character to use as a fill-in.
	//	Returns: A string that is at least `count` characters long starting with `text` and potentially ending with 0 or more repetitiotns of `character`.
	//	Remarks: Actually, `character` might be a string longer than 1 characters, and this function will work as expected.
	static rpad(text, count, character)
	{
		text = String(text);
		const sb = [];
		sb.push(text);
		if (count > text.length) sb.push(Utility.rep(count - text.length, character));
		return sb.join("");
	}

	//	Function: `lpad(text: string, count: uint, character: string): string` - Left-pad the given `text` with `character` to ensure a total of `count` characters in the resulting string.
	//	Parameter: `text: string` - the input string.
	//	Parameter: `count: uint` - the minimum number of characters in the resulting string.
	//	Parameter: `character: string` - the character to use as a fill-in.
	//	Returns: A string that is at least `count` characters long potentially starting with 0 or more repetitiotns of `character` and ending with `text`.
	//	Remarks: Actually, `character` might be a string longer than 1 characters, and this function will work as expected.
	static lpad(text, count, character)
	{
		text = String(text);
		const sb = [];
		if (count > text.length) sb.push(Utility.rep(count - text.length, character));
		sb.push(text);
		return sb.join("");
	}

	//	Function: `erpad(text: string, count: uint): string` - Right-pad with `' '` or right-trim with ellipses the given `text` with `character` to ensure the resulting string is exactly `count` characters long.
	//	Parameter: `text: string` - the input string.
	//	Parameter: `count: uint` - the exact number of characters in the resulting string.
	//	Returns: A right-padded with `' '` or right-trimmed with ellipses version of `text`.
	static erpad(text, count)
	{
		const ellipses = "...";
		if (count == text.length) return text;
		if (count < text.length)
		{
			return text.substr(0, count - ellipses.length) + ellipses;
		}
		return Utility.rpad(text, count, ' ');
	}

	//	Function: Function: `elpad(text: string, count: uint): string` - Left-pad or right-trim with ellipses the given `text` with `character` to ensure the resulting string is exactly `count` characters long.
	//	Parameter: `text: string` - the input string.
	//	Parameter: `count: uint` - the exact number of characters in the resulting string.
	//	Returns: A left-padded with `' '` or left-trimmed with ellipses version of `text`.
	static elpad(text, count)
	{
		const ellipses = "...";
		if (count == text.length) return text;
		if (count < text.length)
		{
			return text.substr(0, count - ellipses.length) + ellipses;
		}
		return Utility.lpad(text, count, ' ');
	}

	//	Function: `fdate(date): string` - Format a date object as `"YYYY-MM-DD HH:mm:ss.lll"`.
	//	Parameter: `date: Date` - the input date to format.
	//	Returns: the date object formatted as `"YYYY-MM-DD HH:mm:ss.lll"`.
	static fdate(date)
	{
		if (!date.getFullYear)
		{
			return Utility.elpad(date, 30);
		}

		const sb = [];
		sb.push(date.getFullYear());
		sb.push("-");
		sb.push(Utility.lpad(date.getMonth() + 1, 2, '0'));
		sb.push("-");
		sb.push(Utility.lpad(date.getDate(), 2, '0'));
		sb.push(" ");
		sb.push(Utility.lpad(date.getHours(), 2, '0'));
		sb.push(":");
		sb.push(Utility.lpad(date.getMinutes(), 2, '0'));
		sb.push(":");
		sb.push(Utility.lpad(date.getSeconds(), 2, '0'));
		sb.push(".");
		sb.push(Utility.lpad(date.getMilliseconds(), 3, '0'));

		const tz = Math.abs(date.getTimezoneOffset());
		const tzSign = date.getTimezoneOffset() < 0 ? "+" : "-";
		const tzHours = Utility.lpad(tz / 60, 2, '0');
		const tzMinutes = Utility.lpad(tz % 60, 2, '0');
		sb.push(" ");
		sb.push(tzSign);
		sb.push(tzHours);
		sb.push(":");
		sb.push(tzMinutes);

		return sb.join("");
	}

	//	Function: `fduration(ms: integer): string` - Format duration in milliseconds as `"Y years MM months DD days HH:mm:ss.lllms"`.
	//	Parameter: `ms: integer` - the input duration value in milliseconds.
	//	Returns: the inout duration in milliseconds as `"Y years MM months DD days HH:mm:ss.lllms"`.
	//	Remarks: Zero values will be ommited from the output, e.g. `"05 months 13:05.314ms"`.
	static fduration(ms)
	{
		const now = new Date();
		const timezoneOffsetMs = now.getTimezoneOffset() * 60 * 1000;
		const dateTime = new Date(ms + timezoneOffsetMs);
		const parts =
		[
			{ postfix: " years ", value: dateTime.getFullYear() - 1970, padding: 4 },
			{ postfix: " months ", value: dateTime.getMonth(), padding: 2 },
			{ postfix: " days ", value: dateTime.getDate() - 1, padding: 2 },
			{ postfix: ":", value: dateTime.getHours(), padding: 2 },
			{ postfix: ":", value: dateTime.getMinutes(), padding: 2 },
			{ postfix: ".", value: dateTime.getSeconds(), padding: 2 },
			{ postfix: "ms", value: dateTime.getMilliseconds(), padding: 3 },
		];

		const sb = [];

		let include = false;
		let includedPartCount = 0;
		for (let length = parts.length, i = 0; i < length; ++i)
		{
			const part = parts[i];
			if (!part.value && !include)
			{
				continue;
			}
			include = true;
			if (!includedPartCount)
			{
				sb.push(part.value);
			}
			else
			{
				sb.push(Utility.lpad(part.value, part.padding, '0'));
			}
			includedPartCount++;
			if (i != length - 1)
			{
				sb.push(part.postfix);
			}
		}

		if (includedPartCount == 1)
		{
			sb.push(parts[parts.length - 1].postfix);
		}

		return sb.join("");
	}
	//#endregion

	//#region Utilities: object formatting
	//	Function: `getKeysText(obj: object): string` - prints a coma-separated list of the enumerable property names of `obj`.
	//	Parameter: `obj: object` - the input object to format.
	//	Returns: a coma-separated list of the enumerable property names of `obj`, e.g. `{a:1, b:"B", c:true}` will produce `"a,b,c"`.
	//	Remarks: This function effectively serializes the top-level of the object schema. Used when building profile hit keys.
	static getKeysText(obj)
	{
		if (!obj) return "";
		const sb = [];
		for (const key in obj) sb.push(key);
		return sb.join(',');
	}

	//	Function: `stripStringify(obj: object, stripFieldPaths: [string]): string` - stringifies `obj` via `JSON.stringify` while replacing all values at the specified `stripFieldPaths` 
	//		by `"(stripped by raw-profiler)"`.
	//	Parameter: `obj: object` - the input object to stringify.
	//	Parameter: `stripFieldPaths: [string]` - an array of property paths in the format `"prop1.prop2.prop3"`.
	//	Returns: a string generated by `JSON.stringify` with all values at the specified `stripFieldPaths` replaced by `"(stripped by raw-profiler)"`.
	//	Remarks:
	//		Always use this function before logging data to make sure that no sensitive data such as unencrypted passwords will appear in the logs.
	//		Does not support stripping of array values or their members. This feature is pending implementation and requires a more complex path syntax that supports array annotation.
	static stripStringify(obj, stripFieldPaths)
	{
		if (!obj)
		{
			return JSON.stringify(obj);
		}

		if (obj instanceof Array)
		{
			return Utility.stripStringifyArray(obj, stripFieldPaths);
		}

		function _resolvePropertyPath(obj, pathText)
		{
			let parent = null;
			let key = null;
			let value = null;
			const path = pathText.split(".");
			for (let length = path.length, i = 0; i < length; ++i)
			{
				key = path[i];
				if (!obj.hasOwnProperty(key))
				{
					return null;
				}
				value = obj[key];
				if (i < length - 1 && !(value instanceof Object))
				{
					return null;
				}
				parent = obj;
				obj = value;
			}
			return {
				parent: parent,
				key: key,
				value: value,
			}
		}

		//keep this commented code for debugging
		//const originalJson = JSON.stringify(obj);
		const original = [];
		for (let length = stripFieldPaths.length, i = 0; i < length; ++i)
		{
			const path = stripFieldPaths[i];
			const resolveInfo = _resolvePropertyPath(obj, path);
			if (!resolveInfo)
			{
				continue;
			}
			original[path] = resolveInfo;
			resolveInfo.parent[resolveInfo.key] = "(stripped by raw-profiler)";
		}
		const result = JSON.stringify(obj);
		for (const path in original)
		{
			const resolveInfo = original[path];
			resolveInfo.parent[resolveInfo.key] = resolveInfo.value;
		}
		//keep this commented code for debugging
		//const finalJson = JSON.stringify(obj);
		//if(originalJson != finalJson)
		//{
		//	throw "ASSERTION FAILED: originalJson == finalJson";
		//}
		return result;
	}

	//	Function: `stripStringifyArray(arr: array, stripFieldPaths: [string]): string` - stringifies `arr` while replacing all values at the specified `stripFieldPaths`
	//		by `"(stripped by raw-profiler)"` (WARNING: at this time stripping in arrays is not implemented).
	//	Parameter: `arr: array` - the input arr to stringify.
	//	Parameter: `stripFieldPaths: [string]` - an array of property paths in the format `"prop1.prop2.prop3"` (WARNING: at this time stripping in arrays is not implemented).
	//	Returns: the array serialized as JSON with all values at the specified `stripFieldPaths` replaced by `"(stripped by raw-profiler)"` (WARNING: at this time stripping in arrays is not implemented).
	//	Remarks:
	//		Always use this function before logging data to make sure that no sensitive data such as unencrypted passwords will appear in the logs.
	//		Does not support stripping of array values or their members. This feature is pending implementation and requires a more complex path syntax that supports array annotation.
	//		As a result, at this time this method is unable to strip anyting.
	static stripStringifyArray(arr, stripFieldPaths)
	{
		if (!arr || !arr.length)
		{
			return JSON.stringify(arr);
		}

		const sb = [];
		sb.push("[");
		for (let length = arr.length, i = 0; i < length; ++i)
		{
			if (i != 0)
			{
				sb.push(", ");
			}
			sb.push(Utility.stripStringify(arr[i], stripFieldPaths));
		}
		sb.push("]");
		return sb.join("");
	}
	//#endregion
}

module.exports = Utility;
module.exports.Utility = module.exports;

// @ts-nocheck -- eslint-config-expo 的 flat 入口尚未提供类型声明
import expoConfig from "eslint-config-expo/flat.js";
import { defineConfig } from "eslint/config";

export default defineConfig([
	expoConfig,
	{
		ignores: ["android/**", ".expo/**"],
		rules: {
			// 本项目使用 React 18，未启用 React Compiler。
			"react/display-name": "off",
			"react-hooks/immutability": "off",
			"react-hooks/preserve-manual-memoization": "off",
			"react-hooks/set-state-in-effect": "off",
		},
	},
	{
		files: ["plugins/**/*.js"],
		languageOptions: {
			globals: {
				__dirname: "readonly",
				module: "readonly",
				require: "readonly",
			},
		},
	},
]);

#!/usr/bin/env node
/** Command line entry point: firmable-icp-fit-scorecard. */
import { runMain } from "firmable-api-client";
import { RECIPE } from "./recipe.js";

runMain(RECIPE);

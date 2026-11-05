import { expect, test } from "bun:test";
import { applicationsNavigation } from "../src/applications-navigation.js";
const html = `<template><a @click="goToApplicationsGrid">My Applications</a></template><script>goToApplicationsGrid() { orbisApp.buildForm({action:'fake-read-navigation',numOfDays:0,comingFromNp:true,refreshSearch:true}, "/myAccount/co-op/full/applications.htm").submit(); }</script>`;
test("discovers the exact Full-Cycle applications read navigation", () => {
  expect(applicationsNavigation(html)).toEqual({action:"fake-read-navigation",numOfDays:"0",comingFromNp:"true",refreshSearch:"true"});
  for(const changed of [html.replace("/full/", "/direct/"),html.replace("refreshSearch:true", "unsafe:true"),html.replace('@click="goToApplicationsGrid"',''),html+html]) expect(()=>applicationsNavigation(changed)).toThrow();
});

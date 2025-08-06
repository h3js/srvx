import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("Hello World!");
  // next(new Error("This is an error!"));
});

const server = app.listen(() => {
  console.log(`Express app listening on port ${server.address()?.port}`);
});

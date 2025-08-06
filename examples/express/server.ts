import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send("Hello World!");
  // next(new Error("This is an error!"));
});

app.listen(3000, () => {
  console.log(`Example app listening on port 3000`);
});

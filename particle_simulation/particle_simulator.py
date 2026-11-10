import marimo

__generated_with = "0.25.2"
app = marimo.App(width="medium")


@app.cell
def _():
    import numpy as np
    import marimo as mo

    return mo, np


@app.cell
def _(np):
    # [time, particle_id, space[x, y, z]]
    # [time, particle_id, space[x, y, z]]
    # [time, particle_id, space[x, y, z]]

    # for t in times:
    #    plot(particle_id, space[x, y, z])

    # time - int 0 to 9
    # particle_id - int, 0 to 999
    # space - rescaled each value to 0 to 1

    # Build a 3d cube of float values
    data = np.random.rand(10, 1000, 2)
    return (data,)


@app.cell
def _(data):
    data[0]
    return


@app.cell
def _(data, mo):
    html_content = "<canvas id='myCanvas' width=400 height=400></canvas>"
    for num_layer in range(data[0].shape[0]):
        point = data[0, num_layer]
        html_content += f"""
        <script>
        var c = document.getElementById("myCanvas");
        var ctx = c.getContext("2d");

        ctx.beginPath();
        ctx.arc({point[0] * 400}, {point[1] * 400}, 5, 0, 2 * Math.PI);
        ctx.stroke();
        </script>
        """


    mo.iframe(html=html_content, width="100%", height="150px")
    return


@app.cell
def _():
    return


if __name__ == "__main__":
    app.run()
